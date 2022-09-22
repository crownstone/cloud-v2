import {inject} from "@loopback/context";
import {SecurityBindings, UserProfile} from "@loopback/security";
import {get, HttpErrors, param, post, requestBody} from '@loopback/rest';
import {authenticate} from "@loopback/authentication";
import {UserProfileDescription} from "../security/authentication-strategies/access-token-strategy";
import {SecurityTypes} from "../config";
import {repository} from "@loopback/repository";
import {SphereRepository} from "../repositories/data/sphere.repository";
import {SphereItem} from "./support/SphereItem";
import {authorize} from "@loopback/authorization";
import {Authorization} from "../security/authorization-strategies/authorization-sphere";
import {Dbs} from "../modules/containers/RepoContainer";
import {sphereFeatures} from "../enums";
import {EnergyUsageCollection} from "../models/endpointModels/energy-usage-collection";
import {EnergyDataProcessor} from "../modules/energy/EnergyProcessor";

const FOREVER = new Date('2100-01-01 00:00:00');

export class Energy extends SphereItem {
  authorizationModelName = "Sphere";

  constructor(
    @inject(SecurityBindings.USER, {optional: true}) public user: UserProfile,
    @repository(SphereRepository) protected sphereRepo: SphereRepository,
  ) { super(); }



  // Allow the collection of power data
  @post('/spheres/{id}/energyUsageCollectionPermission')
  @authenticate(SecurityTypes.accessToken)
  @authorize(Authorization.sphereAdmin())
  async setEnergyUsageCollectionPermission(
    @inject(SecurityBindings.USER) userProfile : UserProfileDescription,
    @param.path.string('id') sphereId: string,
    @param.query.boolean('permission') permission: boolean,
  ): Promise<void> {
    let currentState = await Dbs.sphereFeature.findOne({where:{name: sphereFeatures.ENERGY_COLLECTION_PERMISSION, sphereId: sphereId}});

    if (currentState === null) {
      if (permission === true) {
        await Dbs.sphereFeature.create({name: "ENERGY_COLLECTION_PERMISSION", sphereId: sphereId, enabled: true, from: new Date(), until: FOREVER});
      }
    }
    else {
      if (permission === false) {
        await Dbs.sphereFeature.deleteById(currentState.id);
        return;
      }
      else {
        if (currentState.enabled === false) {
          await Dbs.sphereFeature.updateById(currentState.id, {enabled: true, until: FOREVER});
          return;
        }

        // check if the permission is still valid.
        if (currentState.until < new Date()) {
          await Dbs.sphereFeature.updateById(currentState.id, {until: FOREVER});
          return;
        }
      }
    }
  }


  // Get the permission state of the collection of power data
  @get('/spheres/{id}/energyUsageCollectionPermission')
  @authenticate(SecurityTypes.accessToken)
  @authorize(Authorization.sphereAccess())
  async energyUsageCollectionPermission(
    @inject(SecurityBindings.USER) userProfile : UserProfileDescription,
    @param.path.string('id') sphereId: string,
  ): Promise<boolean> {
    let currentState = await Dbs.sphereFeature.findOne({where:{name: sphereFeatures.ENERGY_COLLECTION_PERMISSION, sphereId: sphereId}});
    if (currentState === null) {
      return false;
    }

    // check if the permission is still valid.
    if (currentState.until < new Date()) {
      await Dbs.sphereFeature.deleteById(currentState.id);
      return false;
    }

    return currentState.enabled;
  }




  // Allow the collection of power data
  @post('/spheres/{id}/energyUsage')
  @authenticate(SecurityTypes.accessToken)
  @authorize(Authorization.sphereAdmin())
  async collectEnergyUsage(
    @inject(SecurityBindings.USER) userProfile : UserProfileDescription,
    @param.path.string('id') sphereId: string,
    @requestBody({required: true}) eneryUsage: EnergyUsageCollection[]
  ): Promise<void> {
    let currentState = await Dbs.sphereFeature.findOne({where:{name: sphereFeatures.ENERGY_COLLECTION_PERMISSION, sphereId: sphereId}});
    if (!currentState?.enabled) { throw new HttpErrors.Forbidden("Energy collection is not enabled for this sphere."); }

    let stoneIdArray = (await Dbs.stone.find({where: {sphereId: sphereId}, fields: {id: true}})).map((stone) => { return stone.id; });
    // create map from array
    let stoneIds : Record<string, true> = {};
    for (let id of stoneIdArray) { stoneIds[id] = true; }

    let pointsToStore = [];
    for (let usage of eneryUsage) {
      if (stoneIds[usage.stoneId] !== true) { continue; }
      pointsToStore.push({stoneId: usage.stoneId, sphereId: sphereId, timestamp: usage.timestamp, energyUsage: usage.energyUsage});
    }

    await Dbs.stoneEnergy.createAll(pointsToStore);

    let processor = new EnergyDataProcessor();
    await processor.processMeasurements(sphereId);
  }






}