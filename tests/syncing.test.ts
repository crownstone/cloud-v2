import {CONFIG} from "../src/config";
CONFIG.emailValidationRequired = false;
CONFIG.generateCustomIds = true;

import {makeUtilDeterministic, resetMockDatabaseIds, resetMockRandom} from "./mocks/CloudUtil.mock";
makeUtilDeterministic();

import {CrownstoneCloud} from "../src/application";
import {Client, createRestAppClient} from '@loopback/testlab';
import {clearTestDatabase, createApp, getRepositories} from "./helpers";
import {createHub, createLocation, createSphere, createStone, createUser} from "./builders/createUserData";
import {auth, getToken} from "./rest-helpers/rest.helpers";
import {SyncHandler} from "../src/modules/sync/SyncHandler";

let app    : CrownstoneCloud;
let client : Client;

let dbs;
let user;
let sphere;
let hub;
let stone,  behaviour,  ability,  abilityProperty;
let stone2, behaviour2, ability2, abilityProperty2;
let stone3, behaviour3, ability3, abilityProperty3;
let location;
let token;

async function populate() {
  // fill with a bit of data for sync
  dbs = getRepositories();
  user     = await createUser('test@test.com', 'test', 0);
  sphere   = await createSphere(user.id, 'mySphere', 0);
  hub      = await createHub(sphere.id, 'myHub', 0);
  ({stone, behaviour, ability, abilityProperty} = await createStone(sphere.id, 'stone1', 0));
  ({stone: stone2, behaviour: behaviour2, ability: ability2, abilityProperty: abilityProperty2} = await createStone(sphere.id, 'stone2', 0));
  ({stone: stone3, behaviour: behaviour3, ability: ability3, abilityProperty: abilityProperty3} = await createStone(sphere.id, 'stone3', 0));
  location = await createLocation(sphere.id, 'location', 0);

  stone.locationId = location.id;
  await dbs.stone.update(stone)
  //
  token  = await getToken(client);
}

beforeEach(async () => {
  await clearTestDatabase();
  resetMockRandom();
  resetMockDatabaseIds();
})
beforeAll(async () => {
  app    = await createApp()
  client = createRestAppClient(app);
})
afterAll(async () => { await app.stop(); })

test("Sync FULL", async () => {
  await populate();
  await client.post(auth("/user/sync"))
    .expect(200)
    .send({sync: {type: "FULL"}})
    .expect(({body}) => {
      expect(body).toMatchSnapshot();
    })
});

test("Sync FULL with scope", async () => {
  await populate();
  let sphereId = sphere.id;

  await client.post(auth("/user/sync"))
    .send({sync: {type: "FULL", scope: ['hubs']}})
    .expect(({body}) => {
      expect(Object.keys(body)).toEqual(['spheres'])
      let sphere = body.spheres[sphereId];
      expect(Object.keys(sphere)).toEqual(['data', 'hubs'])
    })
})
test("Sync REQUEST with empty body", async () => {
  await populate();
  await client.post(auth("/user/sync")).send({sync: {type:"REQUEST"}})
    .expect(({body}) => {expect(body).toMatchSnapshot();})
})
test("Sync REQUEST with empty body and scope", async () => {
  await populate();
  let sphereId = sphere.id;
  await client.post(auth("/user/sync")).send({sync: {type: "REQUEST", scope: ['hubs']}})
    .expect(({body}) => {
      let sphere = body.spheres[sphereId];
      expect(Object.keys(sphere)).toEqual(['data', 'hubs'])
      expect(body).toMatchSnapshot();
    })
});

test("Sync REQUEST with request body", async () => {
  await populate();
  let request = {
    sync: {type: 'REQUEST'},
    user: {data: {updatedAt: 0}},
    spheres: {
      [sphere.id]: {
        data: {updatedAt: 0},
        hubs: {
          [hub.id]: {data: {updatedAt: 0}}
        },
        locations: {
          [location.id]: {data: {updatedAt: 0}}
        },
        scenes: {
          "my-new-scene-id": {data: {updatedAt: 0}}
        },
        stones: {
          [stone.id]: {
            data: {updatedAt: 0},
            behaviours: {[behaviour.id]: {data: {updatedAt: 0},}},
            abilities: {
              [ability.id]: {
                data: {updatedAt: 0},
                properties: {
                  [abilityProperty.id]: {data: {updatedAt: 0},},
                }
              }
            }
          },
          [stone2.id]: {data: {updateAt: 0}}
        },
      }
    }
  }
  await client.post(auth("/user/sync")).send(request)
    .expect(({body}) => {
      expect(body).toMatchSnapshot();
      expect(body.spheres[sphere.id].data.status).toBe("IN_SYNC")
      expect(body.spheres[sphere.id].hubs[hub.id].data.status).toBe("IN_SYNC")
      expect(body.spheres[sphere.id].locations[location.id].data.status).toBe("IN_SYNC")
      expect(body.spheres[sphere.id].scenes["my-new-scene-id"].data.status).toBe("DELETED")
      expect(body.spheres[sphere.id].stones[stone.id].data.status).toBe("IN_SYNC")
      expect(body.spheres[sphere.id].stones[stone.id].behaviours[behaviour.id].data.status).toBe("IN_SYNC")
      expect(body.spheres[sphere.id].stones[stone2.id].data.status).toBe("IN_SYNC")
      expect(body.spheres[sphere.id].stones[stone3.id].data.status).toBe("NEW_DATA_AVAILABLE")
    })
})


test("Sync REQUEST with request body and new items created in the cloud", async () => {
  await populate();
  let request = {
    sync: { type: 'REQUEST' },
    spheres: {
      [sphere.id]: {
        stones: {
          [stone.id]: {
            data: {updatedAt: 0},
            behaviours: {[behaviour.id]: {data: {updatedAt: 0}, }},
            abilities: {[ability.id]: {
                data: {updatedAt: 0},
                properties: {
                  [abilityProperty.id]: {data: {updatedAt: 0}, },
                }
              }}
          },
        },
      }
    }
  }

  let newProp = await dbs.stoneAbilityProperty.create({stoneId: stone.id, abilityId: ability.id, sphereId: sphere.id, type:"test", value:"hello"})
  await client.post(auth("/user/sync")).send(request)
    .expect(({body}) => {
      expect(body.spheres[sphere.id].stones[stone.id]).toMatchSnapshot();
      expect(body.spheres[sphere.id].stones[stone.id].abilities[ability.id].properties[newProp.id].data.status).toBe("NEW_DATA_AVAILABLE")
    })

  let newAbility = await dbs.stoneAbility.create({stoneId: stone.id, sphereId: sphere.id, type:"test", enabled: true, syncedToCrownstone: true})
  let newProp2   = await dbs.stoneAbilityProperty.create({stoneId: stone.id, abilityId: newAbility.id, sphereId: sphere.id, type:"test", value:"hello"})
  await client.post(auth("/user/sync")).send(request)
    .expect(({body}) => {
      expect(body.spheres[sphere.id].stones[stone.id]).toMatchSnapshot();
      expect(body.spheres[sphere.id].stones[stone.id].abilities[newAbility.id].data.status).toBe("NEW_DATA_AVAILABLE")
      expect(body.spheres[sphere.id].stones[stone.id].abilities[newAbility.id].properties[newProp2.id].data.status).toBe("NEW_DATA_AVAILABLE")
    })
});


test("Sync REQUEST with request body and new items from app, propagate new", async () => {
  await populate();
  let request = {
    sync: { type: 'REQUEST' },
    spheres: {
      [sphere.id]: {
        stones: {
          ['hello']: {
            new: true,
            data: {updatedAt: 0, address:'yes!'},
            abilities: {['who']: {
              data: {type:"test", enabled:true, syncedToCrownstone: true, updatedAt: 0},
              properties: {
                ['ack']: {data: {type:"proppy", value:"Yes", updatedAt: 0}, },
              }
            }}
          },
        },
      }
    }
  }

  await client.post(auth("/user/sync")).send(request)
    .expect(({body}) => {
      expect(body.spheres[sphere.id].stones['hello']).toMatchSnapshot();
      expect(body.spheres[sphere.id].stones['hello'].data.status).toBe('CREATED_IN_CLOUD');
      expect(body.spheres[sphere.id].stones['hello'].abilities['who'].data.status).toBe('CREATED_IN_CLOUD');
      expect(body.spheres[sphere.id].stones['hello'].abilities['who'].properties['ack'].data.status).toBe('CREATED_IN_CLOUD');
    })
});


test("Sync REQUEST with request and creation", async () => {
  await populate();
  let request = {
    sync: { type: 'REQUEST' },
    spheres: {
      [sphere.id]: {
        scenes: {
          "my-new-scene-id": {new : true, data: {name: "AWESOME", updatedAt: 0}}
        }
      }
    }
  }
  await client.post(auth("/user/sync")).send(request)
    .expect(({body}) => {
      expect(body.spheres[sphere.id].scenes["my-new-scene-id"].data.status).toBe("CREATED_IN_CLOUD")
    })

  let scenes = await dbs.scene.find();
  expect(scenes).toHaveLength(1)
  expect(scenes[0].name).toBe("AWESOME");
});


test("Sync REQUEST with request and creation outside of scope", async () => {
  await populate();
  let request = {
    sync: { type: 'REQUEST', scope: ['hubs'] },
    spheres: {
      [sphere.id]: {
        scenes: {
          "my-new-scene-id": {new : true, data: {name: "AWESOME", updatedAt: 0}}
        }
      }
    }
  }
  await client.post(auth("/user/sync")).send(request)
    .expect(({body}) => {
      expect(body.spheres[sphere.id].scenes).toBeUndefined()
    })

  let scenes = await dbs.scene.find();
  expect(scenes).toHaveLength(0)
});


test("Sync REQUEST with request and creation with invalid payload", async () => {
  await populate();
  let request = {
    sync: { type: 'REQUEST' as SyncType },
    spheres: {
      [sphere.id]: {
        stones: {
          "my-new-stone-id": {new : true, data: {name: "AWESOME", updatedAt: 0}}
        }
      }
    }
  }
  await client.post(auth("/user/sync")).send(request)
    .expect(({body}) => {
      expect(body.spheres[sphere.id].stones['my-new-stone-id'].data.status).toBe("ERROR");
      expect(body.spheres[sphere.id].stones['my-new-stone-id'].data.error.code).toBe(422);
    })

  let scenes = await dbs.stone.find();
  expect(scenes).toHaveLength(3) // only those we already have.
});

test("Sync REQUEST with unknown sphereId (delete interrupt sphere)", async () => {
  await populate();
  let request = {
    sync: { type: 'REQUEST' as SyncType },
    spheres: {
      ["unknown"]: {
        stones: {
          "my-new-stone-id": {new : true, data: {name: "AWESOME", updatedAt: 0}}
        }
      }
    }
  }
  let result = await SyncHandler.handleSync(user.id, request as any);
  expect(result.spheres["unknown"].data.status).toBe("DELETED");
  expect(Object.keys(result.spheres["unknown"])).toHaveLength(1);
});

test("Sync REQUEST with unknown stoneId (delete interrupt stone)", async () => {
  await populate();
  let request = {
    sync: { type: 'REQUEST' as SyncType },
    spheres: {
      [sphere.id]: {
        stones: {
          ["unknown"]: {data: {name: "AWESOME", updatedAt: 0}}
        }
      }
    }
  }
  let result = await SyncHandler.handleSync(user.id, request as any);
  expect(result.spheres[sphere.id].stones['unknown'].data.status).toBe("DELETED");
  expect(Object.keys(result.spheres[sphere.id].stones['unknown'])).toHaveLength(1);
});

test("Sync REQUEST with unknown abilityId (delete interrupt ability)", async () => {
  await populate();
  let request = {
    sync: {type: 'REQUEST'},
    spheres: {
      [sphere.id]: {
        stones: {
          [stone.id]: {
            data: {updatedAt: 0},
            behaviours: {[behaviour.id]: {data: {updatedAt: 0},}},
            abilities: {
              ["unknown"]: {
                data: {updatedAt: 0},
                properties: {
                  [abilityProperty.id]: {data: {updatedAt: 0},},
                }
              }
            }
          },
        },
      }
    }
  }
  let result = await SyncHandler.handleSync(user.id, request as any);
  expect(result.spheres[sphere.id].stones[stone.id].abilities['unknown'].data.status).toBe("DELETED");
  expect(Object.keys(result.spheres[sphere.id].stones[stone.id].abilities['unknown'])).toHaveLength(1);
});