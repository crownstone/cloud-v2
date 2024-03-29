import { advanceBy, advanceTo, clear } from "jest-date-mock";

import { CONFIG } from "../src/config";
CONFIG.emailValidationRequired = false;
CONFIG.generateCustomIds = true;
CONFIG.unittesting = true;

import { mockSSEmanager } from "./mocks/SSE";
mockSSEmanager();

import {
  makeUtilDeterministic,
  resetMockDatabaseIds,
  resetMockRandom,
} from "./mocks/CloudUtil.mock";
makeUtilDeterministic();

import { CrownstoneCloud } from "../src/application";
import { Client, createRestAppClient } from "@loopback/testlab";
import {
  clearTestDatabase,
  createApp,
  databaseDump,
  getRepositories,
} from "./helpers";
import {
  createMockSphereDatabase,
  resetUsers,
} from "./builders/createUserData";
import { DataSanitizer } from "../src/modules/dataManagement/Sanitizer";
import { Util } from "../src/util/Util";
import { getToken } from "./rest-helpers/rest.helpers";
import { Dbs } from "../src/modules/containers/RepoContainer";

let app: CrownstoneCloud;
let client: Client;

beforeEach(async () => {
  advanceTo(1641034800000); // reset to timestamp "2022-01-01 12:00:00" in this timezone
  await clearTestDatabase();
  resetUsers();
  resetMockRandom();
  resetMockDatabaseIds();
});
beforeAll(async () => {
  app = await createApp();
  client = createRestAppClient(app);
});
afterAll(async () => {
  await app.stop();
});

test("Before deleting users, check sanitation deletion counts", async () => {
  await createMockSphereDatabase(client, "sphere1");
  let result = await DataSanitizer.sanitize();
  expect(result).toMatchSnapshot()
});


test("Check if duplicate abilities are removed", async () => {
  let data = await createMockSphereDatabase(client, "sphere1");
  let stone0 = data.stones[0];

  // create duplicate ability
  let newAbility = await Dbs.stoneAbility.create({stoneId: stone0.id, sphereId: data.sphere.id, type:'switchCraft', enabled: false, syncedToCrownstone: true});
  newAbility.type = 'dimming';
  await Dbs.stoneAbility.update(newAbility);
  let result = await DataSanitizer.sanitize();

  expect(await Dbs.stoneAbility.find({where:{id:newAbility.id}})).toHaveLength(0);
  expect(result).toMatchSnapshot()
});

test("Check if duplicate abilityProperties are removed", async () => {
  let data = await createMockSphereDatabase(client, "sphere1");
  let stone0 = data.stones[0];

  // find ability
  let ability = await Dbs.stoneAbility.findOne({where:{stoneId:stone0.id, type:'dimming'}});

  // create duplicate abilityProperty
  let newAbilityProp = await Dbs.stoneAbilityProperty.create({stoneId: stone0.id, sphereId: data.sphere.id, abilityId: ability.id, type:'test', value: 'true', syncedToCrownstone: true});
  newAbilityProp.type = 'smoothDimming';
  await Dbs.stoneAbilityProperty.update(newAbilityProp);
  console.log(await Dbs.stoneAbilityProperty.find())
  let result = await DataSanitizer.sanitize();

  expect(result).toMatchSnapshot()
});

test("Running twice should not have any effect", async () => {
  await createMockSphereDatabase(client, "sphere1");
  await DataSanitizer.sanitize();
  let initialDump = await databaseDump();
  await DataSanitizer.sanitize();
  let secondDump = await databaseDump();
  expect(initialDump).toStrictEqual(secondDump)
});

test("Before deleting users, check if expired tokens are removed", async () => {
  let sphere = await createMockSphereDatabase(client, "sphere1");

  let initialDump = await databaseDump();
  advanceBy(15 * 24 * 3600 * 1000); // advance time by 15 days. Default TTL = 2 weeks
  await getToken(client, sphere.users.admin);

  await DataSanitizer.sanitize();
  let secondDump = await databaseDump();

  let diff = Util.whatHasBeenChanged(initialDump, secondDump);

  expect(diff.deleted.crownstoneToken).toMatchSnapshot();
  expect(diff.added.crownstoneToken).toMatchSnapshot();
});

test("Before deleting users, check if oauth tokens from missing users are removed", async () => {
  let sphere = await createMockSphereDatabase(client, "sphere1");
  let dbs = getRepositories();
  await dbs.oauthToken.create({
    appId: "appId",
    userId: "nonExisting",
    issuedAt: new Date(),
    refreshToken: "abcde",
  });
  await dbs.oauthToken.create({
    appId: "appId",
    userId: sphere.users.admin.id,
    issuedAt: new Date(),
    refreshToken: "abcde",
  });
  let initialDump = await databaseDump();
  await DataSanitizer.sanitize();
  let secondDump = await databaseDump();
  let diff = Util.whatHasBeenChanged(initialDump, secondDump);

  expect(diff.deleted.oauthToken).toMatchSnapshot();
});

test("Before deleting users, check if orphaned fingerprints are removed.", async () => {
  await createMockSphereDatabase(client, "sphere1");
  // let sphere2 = await createMockSphereDatabase(client, 'sphere2');

  let initialDump = await databaseDump();

  await DataSanitizer.sanitize();

  let secondDump = await databaseDump();
  let diff = Util.whatHasBeenChanged(initialDump, secondDump);

  expect(diff.deleted.fingerprint).toMatchSnapshot();
});

test("Before deleting users, check if unused files are removed.", async () => {
  await createMockSphereDatabase(client, "sphere1");
  // let sphere2 = await createMockSphereDatabase(client, 'sphere2');
  let initialDump = await databaseDump();

  await DataSanitizer.sanitize();

  let secondDump = await databaseDump();
  let diff = Util.whatHasBeenChanged(initialDump, secondDump);

  expect(diff.deleted.fsFiles).toMatchSnapshot();
  expect(diff.deleted.fsChunks).toMatchSnapshot();
});


test("Delete member in sphere and run sanitation, check if all proper data is removed and if all shared data is kept.", async () => {
  let database = await createMockSphereDatabase(client, "sphere1");
  // delete the additional data first to make the rest of the test easier
  await DataSanitizer.sanitize();

  let initialDump = await databaseDump();
  await Dbs.user.deleteById(database.users.member.id);
  let result = await DataSanitizer.sanitize();

  let secondDump = await databaseDump();
  let {deleted, changed} = Util.whatHasBeenChanged(initialDump, secondDump);

  expect(deleted).toMatchSnapshot();

  // keep the shared items
  expect(result.spheres.spheres).toBe(0);
  expect(result.spheres.stones.stones).toBe(0);
  expect(result.spheres.hubs).toBe(0);
  expect(result.spheres.locations).toBe(0);
  expect(result.spheres.scenes).toBe(0);
});


test("Delete member and admin in sphere and run sanitation. Database should be cleared.", async () => {
  let database = await createMockSphereDatabase(client, "sphere1");
  await Dbs.user.deleteById(database.users.member.id);
  // delete the additional data first to make the rest of the test easier
  await DataSanitizer.sanitize();

  await Dbs.user.deleteById(database.users.admin.id);

  let initialDump = await databaseDump();
   await DataSanitizer.sanitize();

  let secondDump = await databaseDump();
  let {deleted, changed} = Util.whatHasBeenChanged(initialDump, secondDump);

  expect(secondDump).toMatchSnapshot();
  expect(deleted).toMatchSnapshot();
});

test("Now with 2 spheres, delete member and admin in sphere2 and run sanitation. " +
  "The data belonging to the two deleted users should be gone and the other data intact.", async () => {
  await createMockSphereDatabase(client, "sphere1");
  // remove isolated data from the mock db before dump.
  await DataSanitizer.sanitize();
  let database1Snapshot = await databaseDump();

  let database2 = await createMockSphereDatabase(client, "sphere2");
  // delete both users from the second mock database
  await Dbs.user.deleteById(database2.users.member.id);
  await Dbs.user.deleteById(database2.users.admin.id);
  // delete the additional data first to make the rest of the test easier
  await DataSanitizer.sanitize();

  let secondDump = await databaseDump();

  expect(database1Snapshot).toStrictEqual(secondDump);
});



test("Check if deleted spheres are removed from user's sphere access", async () => {
  let result = await createMockSphereDatabase(client, "sphere1");
  // sanitize away any duplicate things before this test starts.
  await DataSanitizer.sanitize();

  // add a link to a removed sphere
  await Dbs.sphereAccess.create({userId: result.users.admin.id, sphereId: "RemovedSphereId", role:"admin"});
  expect(await Dbs.sphereAccess.find()).toMatchSnapshot();

  let initialDump = await databaseDump();

  await DataSanitizer.sanitize();

  let secondDump = await databaseDump();
  let diff = Util.whatHasBeenChanged(initialDump, secondDump);

  expect(diff.deleted.sphereAccess).toMatchSnapshot();

  expect(await Dbs.sphereAccess.find()).toMatchSnapshot();
});

