import {inject} from "@loopback/context";
import {SecurityBindings, UserProfile} from "@loopback/security";
import {del, get, getModelSchemaRef, HttpErrors, param, post, requestBody} from '@loopback/rest';
import {authenticate} from "@loopback/authentication";
import {UserProfileDescription} from "../security/authentication-strategies/access-token-strategy";
import {SecurityTypes} from "../config";
import {Count, repository} from "@loopback/repository";
import {SphereRepository} from "../repositories/data/sphere.repository";
import {SphereItem} from "./support/SphereItem";
import {authorize} from "@loopback/authorization";
import {Authorization} from "../security/authorization-strategies/authorization-sphere";
import {Dbs} from "../modules/containers/RepoContainer";
import {sphereFeatures} from "../enums";
import {EnergyDataProcessor} from "../modules/energy/EnergyProcessor";
import {EnergyUsageCollection} from "../models/endpointModels/energy-usage-collection.model";
import {EnergyDataProcessed} from "../models/stoneSubModels/stone-energy-data-processed.model";
import {Filter} from "@loopback/filter/src/query";
import {EnergyMetaData} from "../models/stoneSubModels/stone-energy-metadata.model";
import {EnergyData} from "../models/stoneSubModels/stone-energy-data.model";
import {EnergyIntervalDataSet, UnusedIntervalDataset} from "../modules/energy/IntervalData";


const moment = require('moment-timezone');

const FOREVER = new Date('2100-01-01 00:00:00');

type storeReply = {
  message: string,
  count: number,
}

const energyUsageArray = {
  type: 'array',
  items: {
    'x-ts-type': EnergyUsageCollection,
  },
};

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
  @authorize(Authorization.sphereAdminHub())
  async collectEnergyUsage(
    @inject(SecurityBindings.USER) userProfile : UserProfileDescription,
    @param.path.string('id') sphereId: string,
    @requestBody.array(getModelSchemaRef(EnergyUsageCollection), {required: true}) energyUsage: EnergyUsageCollection[]
  ): Promise<storeReply> {
    let currentState = await Dbs.sphereFeature.findOne({where:{name: sphereFeatures.ENERGY_COLLECTION_PERMISSION, sphereId: sphereId}});
    if (!currentState?.enabled) { throw new HttpErrors.Forbidden("Energy collection is not enabled for this sphere."); }

    let sphereTimezone = await this.sphereRepo.findById(sphereId, {fields: {timezone:true}});
    if (!sphereTimezone.timezone) { throw new HttpErrors.FailedDependency("No timezone is defined for this sphere. Enter the sphere to have it set automatically, or restart your app to have it do so (App version 6.0.0 and higher)."); }


    let stoneIdArray = (await Dbs.stone.find({where: {sphereId: sphereId}, fields: {id: true}})).map((stone) => { return stone.id; });
    // create map from array
    let stoneIds : Record<string, true> = {};
    for (let id of stoneIdArray) { stoneIds[id] = true; }
    let stoneIdsThatHaveData : Record<string, true> = {};

    let pointsToStore = [];
    for (let usage of energyUsage) {
      if (stoneIds[usage.stoneId] !== true) { continue; }
      pointsToStore.push({stoneId: usage.stoneId, sphereId: sphereId, timestamp: usage.t, energyUsage: usage.energy});
      stoneIdsThatHaveData[usage.stoneId] = true;
    }

    await Dbs.stoneEnergy.createAll(pointsToStore);

    let processor = new EnergyDataProcessor();
    await processor.processMeasurements(sphereId);


    // update metadata fields
    if (pointsToStore.length > 0) {
      let result = await Dbs.stoneEnergyMetaData.updateAll({updatedAt: new Date()}, {stoneId: {inq: stoneIdArray}});
      let stoneIdsThatHaveDataArray = Object.keys(stoneIdsThatHaveData);
      // check if we have metadata for all stonesIds
      if (result.count !== stoneIdsThatHaveDataArray.length) {
        let metadata = await Dbs.stoneEnergyMetaData.find({where: {stoneId: {inq: stoneIdArray}}, fields:{stoneId: true}});
        let metaDataIdMap : Record<string, EnergyMetaData> = {};
        for (let meta of metadata) {
          metaDataIdMap[meta.stoneId] = meta;
        }
        let metadataToStore = [];
        for (let stoneId of stoneIdArray) {
          if (metaDataIdMap[stoneId] === undefined) {
            metadataToStore.push({stoneId: stoneId, sphereId: sphereId, updatedAt: new Date()});
          }
        }
        if (metadataToStore.length > 0) {
          await Dbs.stoneEnergyMetaData.createAll(metadataToStore);
        }
      }
    }

    return {message: "Energy usage stored", count: pointsToStore.length};
  }


  // Allow the collection of power data
  @get('/spheres/{id}/energyUsage')
  @authenticate(SecurityTypes.accessToken)
  @authorize(Authorization.sphereMember())
  async getEnergyUsage(
    @inject(SecurityBindings.USER) userProfile : UserProfileDescription,
    @param.path.string('id')       sphereId: string,
    @param.query.dateTime('date', {required:true}) date:    Date,
    // @param.query.dateTime('start', {required:true}) start:    Date,
    // @param.query.dateTime('end',   {required:true})   end:      Date,
    @param.query.string('range',   {required:true})   range:    'day' | 'week' | 'month' | 'year',
  ): Promise<EnergyDataProcessed[]> {
    let sphere = await this.sphereRepo.findById(sphereId, {fields: {timezone:true}});
    if (!sphere.timezone) { throw new HttpErrors.FailedDependency("No timezone is defined for this sphere. Enter the sphere to have it set automatically, or restart your app to have it do so (App version 6.0.0 and higher)."); }

    let sphereTimezone = sphere.timezone;
    // just in case the values are not date objects but strings or timestamps.
    let start : Date;
    let end : Date;

    // ensure we query on round, hourly values.
    // start.setMinutes(0,0,0);
    // end.setMinutes(0,0,0);
    let timestamp = new Date(date).valueOf();

    if (range === "day") {
      start = new Date(EnergyIntervalDataSet['1d'].getPreviousSamplePoint(timestamp, sphereTimezone))
      end   = new Date(EnergyIntervalDataSet['1d'].getNthSamplePoint(start.valueOf(), 1, sphereTimezone))
    }

    if (range === 'week') {
      start = new Date(UnusedIntervalDataset['1w'].getPreviousSamplePoint(timestamp, sphereTimezone))
      end   = new Date(UnusedIntervalDataset['1w'].getNthSamplePoint(start.valueOf(), 1, sphereTimezone))
    }

    if (range === 'month') {
      start = new Date(EnergyIntervalDataSet['1M'].getPreviousSamplePoint(timestamp, sphereTimezone))
      end   = new Date(EnergyIntervalDataSet['1M'].getNthSamplePoint(start.valueOf(), 1, sphereTimezone))
    }

    if (range === 'year') {
      start = moment.tz(timestamp, sphereTimezone).startOf('year').toDate();
      end   = moment.tz(start, sphereTimezone).add(1,'year').toDate();
    }


    let fields : Filter<EnergyDataProcessed | EnergyData> = {fields:['stoneId', 'energyUsage', 'timestamp']};
    let interval : EnergyInterval = '1h';
    let backupInterval : EnergyInterval = '1h';

    switch (range) {
      case 'day':
        interval = '1h';
        backupInterval = '5m';
        break;
      case 'week':
        interval = '1d';
        backupInterval = '1h';
        break;
      case 'month':
        interval = '1d';
        backupInterval = '1h';
        break;
      case 'year':
        interval = '1M';
        backupInterval = '1d';
        break;
      default:
        throw new HttpErrors.BadRequest("Invalid string for \"range\", should be one of these: day, week, month, year");
    }

    let datapoints : any[] = await Dbs.stoneEnergyProcessed.find({
      where: {
        sphereId,
        interval,
        and:[{timestamp: {gte: start}}, {timestamp: {lte: end}}]
      },
      ...fields,
      order:['timestamp ASC']
    });

    let stonesWithData = await Dbs.stoneEnergyMetaData.find({where: {sphereId}, fields: {stoneId: true}});
    let stoneIdsCheckMap : Record<string, boolean> = {};
    for (let stoneMeta of stonesWithData) {
      stoneIdsCheckMap[stoneMeta.stoneId] = false;
    }
    let amountOfStoneIds = Object.keys(stoneIdsCheckMap).length;



    /**
     * @param mapFunction // (point) => { datapoints.push({stoneId: point.stoneId, energyUsage: point.correctedEnergyUsage, timestamp: point.timestamp}); }
     */
    function filterAndInsertPoints(additionalPoints: any[], insertFunction: (point: any) => void) : [boolean, Record<string, boolean>] {
      let stoneIdsWithDataAvailable = {...stoneIdsCheckMap};
      let usedStoneIdCount = 0;
      for (let point of additionalPoints) {
        if (stoneIdsWithDataAvailable[point.stoneId] === false) {
          insertFunction(point);
          stoneIdsWithDataAvailable[point.stoneId] = true;
          usedStoneIdCount++;
          if (usedStoneIdCount === amountOfStoneIds) {
            break;
          }
        }
      }
      return [usedStoneIdCount == amountOfStoneIds, stoneIdsWithDataAvailable];
    }

    /**
     * @param timequery // [{timestamp: {gt: lastTimestamp}}, {timestamp: {lte: end}}]
     * @param order     // 'timestamp DESC'
     */
    async function getAdditionalPoint(timequery: any[], timestampOrder: 'ASC' | 'DESC', processedFirst: boolean, filterInsertEnergyUsage: (point: any) => void, filterInsertEnergyUsageProcessed: (point: any) => void) {
      async function handleProcessed(stoneMapWithDataAvailable: Record<string, boolean> = stoneIdsCheckMap) : Promise<[boolean, Record<string, boolean>]>  {
        let stoneIds = [];
        for (let stoneId in stoneMapWithDataAvailable) {
          if (stoneMapWithDataAvailable[stoneId] === false) {
            stoneIds.push(stoneId);
          }
        }

        if (stoneIds.length === 0) {
          return [false, stoneMapWithDataAvailable];
        }
        // this gets more data than we need, but the alternative is that we do a findOne query for each stoneId, which is much slower.
        // we can filter out the data we do not need.
        let additionalPoints = await Dbs.stoneEnergyProcessed.find({
          where: { sphereId, stoneId: {inq:stoneIds}, interval: backupInterval, and:timequery },
          ...fields,
          order: [`timestamp ${timestampOrder}`],
        });

        if (additionalPoints.length > 0) {
          return filterAndInsertPoints(additionalPoints, filterInsertEnergyUsageProcessed);
        }

        return [false, {...stoneMapWithDataAvailable}];
      }

      async function handleRaw(stoneMapWithDataAvailable: Record<string, boolean> = stoneIdsCheckMap) : Promise<[boolean, Record<string, boolean>]>  {
        let stoneIds = [];
        for (let stoneId in stoneMapWithDataAvailable) {
          if (stoneMapWithDataAvailable[stoneId] === false) {
            stoneIds.push(stoneId);
          }
        }

        if (stoneIds.length === 0) {
          return [false, stoneMapWithDataAvailable];
        }

        // get a point for the next interval, even if it might be partial.
        let additionalPoints = await Dbs.stoneEnergy.find({
          where: { sphereId, stoneId:{inq:stoneIds}, energyUsage: {gt: 0}, correctedEnergyUsage: {gt: 0}, checked: true, and:timequery},
          fields: ['stoneId', 'energyUsage', 'timestamp', 'correctedEnergyUsage'],
          order:  [`timestamp ${timestampOrder}`],
        });

        if (additionalPoints.length > 0) {
          return filterAndInsertPoints(additionalPoints, filterInsertEnergyUsage);
        }
        return [false, {...stoneMapWithDataAvailable}];
      }


      /**
       * We could further improve this by checking if the first step has given data for all stoneIds. If not, try those in the second step.
       */
      if (processedFirst) {
        let dataObtained = await handleProcessed();
        if (dataObtained[0] === false) {
          await handleRaw(dataObtained[1]);
        }
      }
      else {
        let dataObtained = await handleRaw();
        if (dataObtained[0] === false) {
          await handleProcessed(dataObtained[1]);
        }
      }

    }

    // if we do not have a fully filled range, check if we have a pending unprocessed value which provides the most up-to-date data.

    // check if we need an additional point at the start.
    let firstTimestamp = datapoints[0]?.timestamp ?? end;
    if (firstTimestamp > start) {
      await getAdditionalPoint(
        [{timestamp: {gte: start}}, {timestamp: {lt: firstTimestamp}}],
        'ASC',
        true,
        (point) => { datapoints.unshift({stoneId: point.stoneId, energyUsage: point.correctedEnergyUsage, timestamp: point.timestamp});  },
        (point) => {datapoints.unshift(point);  }
      );
    }

    // check if we need an additional point at the end.
    let lastTimestamp = datapoints[datapoints.length-1]?.timestamp ?? start;
    if (lastTimestamp < end) {
      await getAdditionalPoint(
        [{timestamp: {gt: lastTimestamp}}, {timestamp: {lte: end}}],
        'DESC',
        false,
        (point) => { datapoints.push({stoneId: point.stoneId, energyUsage: point.correctedEnergyUsage, timestamp: point.timestamp}); },
        (point) => { datapoints.push(point); }
      );
    }


    datapoints.sort((a,b) => {
      if (a.timestamp === b.timestamp) {
        return String(a.stoneId).localeCompare(String(b.stoneId));
      }
      else {
        return a.timestamp - b.timestamp
      }
    });

    return datapoints;
  }


  // Allow the collection of power data
  @del('/stones/{id}/energyUsage')
  @authenticate(SecurityTypes.accessToken)
  @authorize(Authorization.sphereAdmin("Stone"))
  async deleteEnergyUsage(
    @inject(SecurityBindings.USER) userProfile : UserProfileDescription,
    @param.path.string('id')    stoneId: string,
    @param.query.dateTime('start', {required: true})   fromDate: Date,
    @param.query.dateTime('end', {required: true})  untilDate: Date,
  ): Promise<Count> {

    let count          = await Dbs.stoneEnergy.deleteAll({stoneId: stoneId, and: [{timestamp: {gte: fromDate}}, {timestamp: {lt: untilDate}}]});
    let processedCount = await Dbs.stoneEnergyProcessed.deleteAll({stoneId: stoneId, timestamp: {gte: fromDate, lt: untilDate}});

    return {count: count.count + processedCount.count};
  }





}
