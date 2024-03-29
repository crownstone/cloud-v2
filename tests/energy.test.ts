import {CONFIG} from "../src/config";
CONFIG.emailValidationRequired = false;

import {CrownstoneCloud} from "../src/application";
import {Client, createRestAppClient} from '@loopback/testlab';
import {clearTestDatabase, createApp, getRepositories} from "./helpers";
import {createHub, createLocation, createSphere, createStone, createUser} from "./builders/createUserData";
import {CloudUtil} from "../src/util/CloudUtil";
import {auth, getToken, login} from "./rest-helpers/rest.helpers";
import {AggegateAllSpheres, EnergyDataProcessor} from "../src/modules/energy/EnergyProcessor";
import {EnergyUsageCollection} from "../src/models/endpointModels/energy-usage-collection.model";
import {EnergyIntervalDataSet} from "../src/modules/energy/IntervalData";
import {Dbs} from "../src/modules/containers/RepoContainer";
// import {EnergyDataProcessor} from "../src/modules/energy/EnergyProcessor";

const moment = require('moment-timezone');

let app    : CrownstoneCloud;
let client : Client;
let repos  = getRepositories();

const timezone = "Europe/Amsterdam";

beforeEach(async () => { await clearTestDatabase(); })
beforeAll(async () => {
  app    = await createApp()
  client = createRestAppClient(app);
})
afterAll(async () => { await app.stop(); })

let dbs;
let admin;
let member;
let guest;
let sphere;
let hub;
let stone,  behaviour,  ability,  abilityProperty;
let stone2, behaviour2, ability2, abilityProperty2;
let stone3, behaviour3, ability3, abilityProperty3;
let location;
let token;

let INTERVAL = 5*60;

function m(x,a) { return new Date('2022-01-01 01:00:00Z').valueOf() + x*INTERVAL*1000 + a*1000}

function gen(stone: any, value: number, timestamp: number) : Partial<EnergyUsageCollection> {
  return {
    stoneId: stone.id,
    energy: value,
    t: new Date(timestamp)
  }
}
function get(arr: any[], stone, value, timestamp) {
  arr.push(gen(stone, value, timestamp))
}

async function populate() {
  // fill with a bit of data for sync
  dbs = getRepositories();
  admin    = await createUser('admin@test.com',  'test', 0);
  member   = await createUser('member@test.com', 'test', 0);
  guest    = await createUser('guest@test.com',  'test', 0);
  sphere   = await createSphere(admin.id, 'mySphere', 0);
  await dbs.sphereAccess.create({sphereId: sphere.id, userId: member.id, role:'member', sphereAuthorizationToken: CloudUtil.createToken()});
  await dbs.sphereAccess.create({sphereId: sphere.id, userId: guest.id,  role:'guest',  sphereAuthorizationToken: CloudUtil.createToken()});
  hub      = await createHub(sphere.id, 'myHub', 0);
  ({stone, behaviour, ability, abilityProperty} = await createStone(sphere.id, 'stone1', 0));
  ({stone: stone2, behaviour: behaviour2, ability: ability2, abilityProperty: abilityProperty2} = await createStone(sphere.id, 'stone2', 0));
  ({stone: stone3, behaviour: behaviour3, ability: ability3, abilityProperty: abilityProperty3} = await createStone(sphere.id, 'stone3', 0));
  location = await createLocation(sphere.id, 'location', 0);

  stone.locationId = location.id;
  await dbs.stone.update(stone)
  token = await getToken(client, admin);
}

async function prepare() {
  await populate();
  let sphereId = sphere.id;
  // enable collection of energy data.
  await client.post(auth(`/spheres/${sphereId}/energyUsageCollectionPermission?permission=true`))
}

test("test blocking energy loading if permission is not granted", async () => {
  await populate();

  // add some energy data
  let data = [];
  get(data, stone, 1000, m(0,0));
  get(data, stone, 2000, m(1,0));
  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data)
    .expect(({body})=> {
      expect(body).toHaveProperty('error');
      expect(body?.error).toHaveProperty('message', 'Energy collection is not enabled for this sphere.');
      expect(body?.error).toHaveProperty('statusCode', 403);
    })
});


test("test revoking permissions", async () => {
  await prepare();

  // add some energy data
  let data = [];
  get(data, stone, 1000, m(0,0));
  get(data, stone, 2000, m(1,0));
  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data)
    .expect(({body})=> {
      expect(body).not.toHaveProperty('error');
    })

  await client.post(auth(`/spheres/${sphere.id}/energyUsageCollectionPermission?permission=false`))
  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data)
    .expect(({body})=> {
      expect(body).toHaveProperty('error');
      expect(body?.error).toHaveProperty('message', 'Energy collection is not enabled for this sphere.');
      expect(body?.error).toHaveProperty('statusCode', 403);
    })
});


test("test energy loading", async () => {
  await prepare();

  // add some energy data
  let data = [];
  get(data, stone, 1000, m(0,0));
  get(data, stone, 2000, m(1,0));
  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data)

  let processedPoints = await dbs.stoneEnergyProcessed.find()
  expect(processedPoints.length).toBe(2)
  expect(processedPoints[0].energyUsage).toBe(1000)
  expect(processedPoints[1].energyUsage).toBe(2000)
  expect(await dbs.stoneEnergy.find()).toHaveLength(1)
});



test("check processing energy data without interpolation WITH a gap", async () => {
  await prepare();

  let data = [];
  get(data, stone, 1000, m(0,0));
  get(data, stone, 2000, m(1,0));
  get(data, stone, 3000, m(8,0));

  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data)

  data = [];
  get(data, stone, 4000, m(9,0));

  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data)

  let processedPoints = await dbs.stoneEnergyProcessed.find();
  expect(processedPoints.length).toBe(4);
  expect(await dbs.stoneEnergy.find()).toHaveLength(1);
});


test("check processing energy data without interpolation WITH a gap 2", async () => {
  await prepare();

  let data = [];
  get(data, stone, 1000, m(0,0));
  get(data, stone, 2000, m(1,0));
  get(data, stone, 3000, m(8,0));
  get(data, stone, 4000, m(9,0));

  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data)


  let processedPoints = await dbs.stoneEnergyProcessed.find()
  expect(processedPoints.length).toBe(4)
  expect(await dbs.stoneEnergy.find()).toHaveLength(1)
});


test("check processing energy data in normal situation", async () => {
  await prepare();

  let data = [];
  get(data, stone, 1000,  m(0,1));
  get(data, stone, 2000,  m(1,4));
  get(data, stone, 3000,  m(2,0));
  get(data, stone, 4000,  m(5,4));

  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data)

  let energyPoints    = await dbs.stoneEnergy.find()
  let processedPoints = await dbs.stoneEnergyProcessed.find()

  expect(processedPoints.length).toBe(5)
  let period = INTERVAL;

  expect(processedPoints[0].energyUsage).toBe(Math.round((1000/(1*period + 3))*(1*period - 1)+1000));
  expect(processedPoints[1].energyUsage).toBe(3000);
  expect(processedPoints[2].energyUsage).toBe(Math.round((1000/(3*period+4))*(1*period) + 3000));
  expect(processedPoints[3].energyUsage).toBe(Math.round((1000/(3*period+4))*(2*period) + 3000));
  expect(processedPoints[4].energyUsage).toBe(Math.round((1000/(3*period+4))*(3*period) + 3000));

  for (let i = 0; i < energyPoints.length-1;i++) {
    expect(energyPoints[i].processed).toBe(true);
  }
  expect(energyPoints[energyPoints.length -1].processed).toBe(true);
  expect(await dbs.stoneEnergy.find()).toHaveLength(1)
});

test("check reboot detection and handling", async () => {
  await prepare();

  let data = [];
  get(data, stone, 1000,  m(0,1));
  get(data, stone, 0,     m(2,4));
  get(data, stone, 3000,  m(4,0));

  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data)

  let period = INTERVAL;
  let processedPoints = await dbs.stoneEnergyProcessed.find()
  expect(processedPoints[0].energyUsage).toBe(1000);
  expect(processedPoints[1].energyUsage).toBe(1000);
  expect(processedPoints[2].energyUsage).toBe(Math.round((3000/((2*period)-4))*((1*period)-4)) + 1000); // diff/dt * 1periodDt
  expect(processedPoints[3].energyUsage).toBe(3000 + 1000);
  expect(await dbs.stoneEnergy.find()).toHaveLength(1)
});


test("check large gap", async () => {
  await prepare();

  let data = [];

  get(data, stone, 1000, m(0,1))
  get(data, stone, 2000, m(1,1))
  get(data, stone, 3000, m(9,0))
  get(data, stone, 4000, m(10,0))

  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data)
  let processedPoints = await dbs.stoneEnergyProcessed.find()
  expect(processedPoints.length).toBe(3)
  expect(await dbs.stoneEnergy.find()).toHaveLength(1)
});


test("check resuming after zero measurement gap", async () => {
  await prepare();

  let data = [];

  get(data, stone, 1000, m(0,0))
  get(data, stone, 0, m(1,1))
  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data)
  
  data = [];
  get(data, stone, 3000, m(9,0))
  get(data, stone, 4000, m(10,0))
  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data)

  
  let processedPoints = await dbs.stoneEnergyProcessed.find()
  expect(processedPoints[0].energyUsage).toBe(1000);
  expect(processedPoints[1].energyUsage).toBe(1000);
  expect(processedPoints[2].energyUsage).toBe(3000 + 1000);
  expect(processedPoints[3].energyUsage).toBe(4000 + 1000);
  expect(await dbs.stoneEnergy.find()).toHaveLength(1)
});



test("check double reboot gap", async () => {
  await prepare();

  let data = [];

  get(data, stone, 40000, m(0,0))// 40000
  get(data, stone, 0,     m(1,1))// 40000
  get(data, stone, 3000,  m(2,0))// 43000
  get(data, stone, 4000,  m(3,0))// 44000
  get(data, stone, 20000, m(4,0))// 60000
  get(data, stone, 0,     m(5,1))// 60000
  get(data, stone, 3000,  m(6,0))// 63000
  get(data, stone, 4000,  m(7,0))// 64000
  get(data, stone, 20000, m(8,0))// 80000

  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data)

  let processedPoints = await dbs.stoneEnergyProcessed.find()
  expect(processedPoints[0].energyUsage).toBe(40000);
  expect(processedPoints[1].energyUsage).toBe(40000);
  expect(processedPoints[2].energyUsage).toBe(43000);
  expect(processedPoints[3].energyUsage).toBe(44000);
  expect(processedPoints[4].energyUsage).toBe(60000);
  expect(processedPoints[5].energyUsage).toBe(60000);
  expect(processedPoints[6].energyUsage).toBe(63000);
  expect(processedPoints[7].energyUsage).toBe(64000);
  expect(processedPoints[8].energyUsage).toBe(80000);
  expect(await dbs.stoneEnergy.find()).toHaveLength(1)
});



test("check double reboot gap with not exactly zero numbers", async () => {
  await prepare();

  let data = [];

  get(data, stone, 40000, m(0,0));   // 40000
  get(data, stone, 200, m(1,0));     // 40000
  get(data, stone, 3000, m(2,0));    // 43000
  get(data, stone, 4000, m(3,0));    // 44000
  get(data, stone, 20000, m(4,0));   // 60000
  get(data, stone, 260, m(5,0));     // 60000
  get(data, stone, 3000, m(6,0));    // 63000
  get(data, stone, 4000, m(7,0));    // 64000
  get(data, stone, 20000, m(8,0));   // 80000

  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data)

  let processedPoints = await dbs.stoneEnergyProcessed.find()
  expect(processedPoints[0].energyUsage).toBe(40000);
  expect(processedPoints[1].energyUsage).toBe(200   + 40000);
  expect(processedPoints[2].energyUsage).toBe(3000  + 40000);
  expect(processedPoints[3].energyUsage).toBe(4000  + 40000);
  expect(processedPoints[4].energyUsage).toBe(20000 + 40000);
  expect(processedPoints[5].energyUsage).toBe(260   + 20000 + 40000);
  expect(processedPoints[6].energyUsage).toBe(3000  + 20000 + 40000);
  expect(processedPoints[7].energyUsage).toBe(4000  + 20000 + 40000);
  expect(processedPoints[8].energyUsage).toBe(20000 + 20000 + 40000);
  expect(await dbs.stoneEnergy.find()).toHaveLength(1)
});



test("check duplicate handling", async () => {
  await prepare();

  let data = [];

  get(data, stone, 1000, m(1,0))
  get(data, stone, 3000, m(2,0))
  get(data, stone, 3000, m(2,0))
  get(data, stone, 3000, m(2,0))
  get(data, stone, 4000, m(3,0))

  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data)

  let processedPoints = await dbs.stoneEnergyProcessed.find()
  expect(processedPoints.length).toBe(3);
  expect(await dbs.stoneEnergy.find()).toHaveLength(1)
});



test("check correct handling of small decreases in energy", async () => {
  await prepare();

  let data = [];

  get(data, stone, 100100, m(1,0))
  get(data, stone, 100000, m(3,6))
  get(data, stone, 100000, m(4,6))
  get(data, stone, 100100, m(5,6))

  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data)

  let processedPoints = await dbs.stoneEnergyProcessed.find();
  expect(processedPoints[0].energyUsage).toBe(100100);
  expect(processedPoints[1].energyUsage).toBe(100100);
  expect(processedPoints[2].energyUsage).toBe(100100);
  expect(processedPoints[3].energyUsage).toBe(100100);
  expect(await dbs.stoneEnergy.find()).toHaveLength(1);
});


test("check correct handling of energyData deletion", async () => {
  await prepare();

  let data = [];

  get(data, stone, 100, m(0,0))
  get(data, stone, 101, m(0,1))
  get(data, stone, 102, m(0,2))
  get(data, stone, 103, m(0,4))
  get(data, stone, 103, m(0,30))

  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data)

  expect(await dbs.stoneEnergy.find()).toHaveLength(1);
  expect(await dbs.stoneEnergyProcessed.find()).toHaveLength(1);

  data = [];
  get(data, stone, 103, m(1,2))
  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data)
  expect(await dbs.stoneEnergy.find()).toHaveLength(1);
  expect(await dbs.stoneEnergyProcessed.find()).toHaveLength(2);
});

test("check correct handling of energyData deletion without datapoints on intervals", async () => {
  await prepare();

  let data = [];

  get(data, stone, 101, m(0,1))
  get(data, stone, 102, m(0,2))
  get(data, stone, 103, m(0,4))
  get(data, stone, 103, m(0,30))

  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data)

  expect(await dbs.stoneEnergy.find()).toHaveLength(4);
  expect(await dbs.stoneEnergyProcessed.find()).toHaveLength(0);
});



test("check correct handling of energyData without datapoints on intervals 2", async () => {
  await prepare();

  let data = [];

  get(data, stone, 101, m(0,0))
  get(data, stone, 102, m(10,0))
  get(data, stone, 103, m(10,4))
  get(data, stone, 103, m(10,30))

  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data)

  expect(await dbs.stoneEnergy.find()).toHaveLength(1);
  expect(await dbs.stoneEnergyProcessed.find()).toHaveLength(2);
});


test("Energy interval calculation", async () => {


  let hour = EnergyIntervalDataSet['1h'];
  expect(hour.isOnSamplePoint(moment.tz('2022-01-01T00:00:00.00', timezone).valueOf(), timezone)).toBe(true);
  expect(hour.isOnSamplePoint(moment.tz('2022-01-01T00:04:00', timezone).valueOf(), timezone)).toBe(false);
  expect(hour.getPreviousSamplePoint(moment.tz('2022-01-01T00:45:00', timezone).valueOf(), timezone)).toBe(moment.tz('2022-01-01T00:00:00', timezone).valueOf());
  expect(hour.getNthSamplePoint(moment.tz('2022-01-01T00:00:00', timezone).valueOf(), 5, timezone)).toBe(moment.tz('2022-01-01T05:00:00', timezone).valueOf());
  expect(hour.getNumberOfSamplePointsBetween(moment.tz('2022-01-01T00:00:00', timezone).valueOf(), moment.tz('2022-01-01T05:00:00', timezone).valueOf(), timezone)).toBe(5);

  let day   = EnergyIntervalDataSet['1d'];
  expect(day.isOnSamplePoint(moment.tz('2022-01-01T00:00:00', timezone).valueOf(), timezone)).toBe(true);
  expect(day.isOnSamplePoint(moment.tz('2022-01-01T00:04:00', timezone).valueOf(), timezone)).toBe(false);
  expect(day.getPreviousSamplePoint(moment.tz('2022-01-01T00:45:00', timezone).valueOf(), timezone)).toBe(moment.tz('2022-01-01T00:00:00', timezone).valueOf());
  expect(day.getNthSamplePoint(moment.tz('2022-01-01T00:00:00', timezone).valueOf(), 5, timezone)).toBe(moment.tz('2022-01-06T00:00:00', timezone).valueOf());
  expect(day.getNumberOfSamplePointsBetween(moment.tz('2022-01-01T00:00:00', timezone).valueOf(), moment.tz('2022-01-06T00:00:00', timezone).valueOf(), timezone)).toBe(5);


  let month = EnergyIntervalDataSet['1M'];
  expect(month.isOnSamplePoint(moment.tz('2022-01-01T00:00:00', timezone).valueOf(), timezone)).toBe(true);
  expect(month.isOnSamplePoint(moment.tz('2022-01-01T00:04:00', timezone).valueOf(), timezone)).toBe(false);
  expect(month.getPreviousSamplePoint(moment.tz('2022-01-01T00:45:00', timezone).valueOf(), timezone)).toBe(moment.tz('2022-01-01T00:00:00', timezone).valueOf());
  expect(month.getNthSamplePoint(moment.tz('2022-01-01T00:00:00', timezone).valueOf(), 5, timezone)).toBe(moment.tz('2022-06-01T00:00:00', timezone).valueOf());
  expect(month.getNumberOfSamplePointsBetween(moment.tz('2022-01-01T00:00:00', timezone).valueOf(), moment.tz('2022-06-01T00:00:00', timezone).valueOf(), timezone)).toBe(5);


})




test("Aggregation of energy usage: month", async () => {
  await prepare();

  function getDate(i) {
    return moment.tz('2022-01-01T03:00:03', timezone).add(40*i, 'minutes').toDate();
  }
  let data = [];
  let datapoints = 300;
  for (let i = 0; i < datapoints; i++) {
    get(data, stone, i*10000, getDate(i))
  }

  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data);
  let processor = new EnergyDataProcessor();
  await processor.processAggregations(sphere.id);

  expect(await dbs.stoneEnergyProcessed.find({where:{interval: '1h' }})).toHaveLength(198);
  expect(await dbs.stoneEnergyProcessed.find({where:{interval: '1d' }})).toHaveLength(8);
  expect(await dbs.stoneEnergyProcessed.find({where:{interval: '1M' }})).toHaveLength(0);
  expect(await dbs.stoneEnergyProcessed.find({where:{interval:'fragment'}})).toHaveLength(1);
}, 10000)



test("check getting of energy data, day, week", async () => {
  await prepare();

  function getDate(i) : Date {
    return moment.tz('2022-01-01T03:00:03', timezone).add(40*i, 'minutes').toDate();
  }

  let data = [];
  let datapoints = 800;
  for (let i = 0; i < datapoints; i++) {
    get(data, stone, i*10000, getDate(i))
  }

  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data);

  let processor = new EnergyDataProcessor();
  await processor.processAggregations(sphere.id);

  await client.get(auth(`/spheres/${sphere.id}/energyUsage?date=${ getDate(150).toISOString() }&range=day`)).expect(({body}) => {
    expect(body).toHaveLength(25);
  });

  await client.get(auth(`/spheres/${sphere.id}/energyUsage?date=${ moment.tz('2022-01-08',timezone).toDate().toISOString() }&range=week`)).expect(({body}) => {
    expect(body).toHaveLength(8);
    for (let i = 0; i < body.length;i++) {
      expect(moment(body[i].timestamp).tz(timezone).day()).toBe((i+1)%7);
    }
  });
}, 10000);


test("check getting of energy data, day, fragemented", async () => {
  await prepare();

  function getDate(i) : Date {
    return moment.tz('2022-01-01T03:00:03', timezone).add(40*i, 'minutes').toDate();
  }

  let data = [];
  let datapoints = 23;
  // console.log('from', getDate(0).toISOString(), 'to', getDate(datapoints).toISOString())
  for (let i = 0; i < datapoints; i++) {
    get(data, stone, i*10000, getDate(i))
  }

  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data);

  let processor = new EnergyDataProcessor();
  await processor.processAggregations(sphere.id);

  await client.get(auth(`/spheres/${sphere.id}/energyUsage?date=${ getDate(1).toISOString() }&range=day`)).expect(({body}) => {
    expect(body).toHaveLength(15);
  });
}, 10000);



test("check getting of energy data, month, year", async () => {
  await prepare();

  function getDate(i) : Date {
    return moment.tz('2021-12-01T00:00:03', timezone).add(12*i, 'hours').add(40*i, 'minutes').toDate();
  }

  let data = [];
  let datapoints = 800;
  console.log('from', getDate(0).toISOString(), 'to', getDate(datapoints).toISOString())
  for (let i = 0; i < datapoints; i++) {
    get(data, stone, i*10000, getDate(i))
  }

  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data);

  let processor = new EnergyDataProcessor();
  await processor.processAggregations(sphere.id);


  await client.get(auth(`/spheres/${sphere.id}/energyUsage?date=${ moment.tz('2022-01-08', timezone).toISOString() }&range=month`)).expect(({body}) => {
    expect(body).toHaveLength(32);
  });

  await client.get(auth(`/spheres/${sphere.id}/energyUsage?date=${ moment.tz('2022-01-08', timezone).toISOString() }&range=year`)).expect(({body}) => {
    expect(body).toHaveLength(13);
  });
}, 10000);


test("check aggregation via main aggregator", async () => {
  await prepare();

  function getDate(i) : Date {
    return moment.tz('2021-12-01T00:00:03', timezone).add(12*i, 'hours').add(40*i, 'minutes').toDate();
  }

  let data = [];
  let datapoints = 800;
  for (let i = 0; i < datapoints; i++) {
    get(data, stone, i*10000, getDate(i))
  }

  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data);

  await AggegateAllSpheres();
  await AggegateAllSpheres();
  await AggegateAllSpheres();
  await AggegateAllSpheres();

  await client.get(auth(`/spheres/${sphere.id}/energyUsage?date=${ moment.tz('2022-01-08', timezone).toISOString() }&range=month`)).expect(({body}) => {
    expect(body).toHaveLength(32);
  });

  await client.get(auth(`/spheres/${sphere.id}/energyUsage?date=${ moment.tz('2022-01-08', timezone).toISOString() }&range=year`)).expect(({body}) => {
    expect(body).toHaveLength(13);
  });
}, 10000);


test("check year aggregation", async () => {
  await prepare();

  let data = [];
  get(data, stone, 1e4, moment.tz('2022-09-13T03:00:00', timezone).toDate())
  get(data, stone, 1e4, moment.tz('2022-09-14T03:00:00', timezone).toDate())
  get(data, stone, 1e5, moment.tz('2022-09-15T03:00:00', timezone).toDate())
  get(data, stone, 2e5, moment.tz('2022-09-16T03:00:00', timezone).toDate())
  get(data, stone, 12e5, moment.tz('2022-10-15T03:00:00', timezone).toDate())
  get(data, stone, 13e5, moment.tz('2022-10-16T03:00:00', timezone).toDate())
  get(data, stone, 23e5, moment.tz('2022-11-15T03:00:00', timezone).toDate())
  get(data, stone, 24e5, moment.tz('2022-11-16T03:00:00', timezone).toDate())

  get(data, stone2, 1e5, moment.tz('2022-09-15T03:00:00', timezone).toDate())
  get(data, stone2, 2e5, moment.tz('2022-09-16T03:00:00', timezone).toDate())
  get(data, stone2, 12e5, moment.tz('2022-10-15T03:00:00', timezone).toDate())
  get(data, stone2, 13e5, moment.tz('2022-10-16T03:00:00', timezone).toDate())
  get(data, stone2, 23e5, moment.tz('2022-11-15T03:00:00', timezone).toDate())
  get(data, stone2, 24e5, moment.tz('2022-11-16T03:00:00', timezone).toDate())
  get(data, stone2, 25e5, moment.tz('2022-11-17T03:00:00', timezone).toDate())

  await client.post(auth(`/spheres/${sphere.id}/energyUsage`)).send(data);

  let processor = new EnergyDataProcessor();
  await processor.processAggregations(sphere.id);

  // console.log(await Dbs.stoneEnergyProcessed.find());
  await client.get(auth(`/spheres/${sphere.id}/energyUsage?date=${ moment.tz('2022-01-08', timezone).toISOString() }&range=year`)).expect(({body}) => {
    expect(body).toHaveLength(8);
    console.log(body)
  });
});

