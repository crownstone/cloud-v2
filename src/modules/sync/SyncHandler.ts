import {Dbs} from "../containers/RepoContainer";
import {HttpErrors} from "@loopback/rest";
import {SyncRequestResponse, SyncRequestResponse_Sphere, SyncResponseStone} from "../../declarations/syncTypes";
import {Sphere} from "../../models/sphere.model";
import {getShallowReply} from "./helpers/ReplyHelpers";
import {
  filterForAppVersion, getHighestVersionPerHardwareVersion,
  getIds,
  getNestedIdMap,
  getSyncIgnoreList,
  getUniqueIdMap, sortByHardwareVersion
} from "./helpers/SyncUtil";
import {User} from "../../models/user.model";
import { hardwareVersions } from '../../constants/hardwareVersions';
import {Bootloader } from "../../models/bootloader.model";
import {Firmware} from "../../models/firmware.model";
import {getEncryptionKeys} from "./helpers/KeyUtil";
import {EventHandler} from "../sse/EventHandler";
import {Sync_SphereComponents} from "./syncers/Sync_Constructor";
import {EventSphereCache} from "../sse/events/EventConstructor";
import {SphereAccessUtil} from "../../util/SphereAccessUtil";
import {Util} from "../../util/Util";
import {filterForMyMessages} from "../../controllers/message.controller";
import {MessageV2} from "../../models/messageV2.model";
import {MessageRecipientUser} from "../../models/messageSubModels/message-recipient-user.model";
import {MessageDeletedByUser} from "../../models/messageSubModels/message-deletedBy-user.model";
import {MessageReadByUser} from "../../models/messageSubModels/message-readBy-user.model";


let sphereRelationsMap : {[id:string]:boolean} = {
  // features:        true,
  messages:        true,
  hubs:            true,
  scenes:          true,
  sortedLists:     true,
  trackingNumbers: true,
  toons:           true,
  locations:       true,
  stones:          true,
}

class Syncer {

  /**
   * This downloads everything in the required sphere.
   * @param sphereId
   * @param status
   */
  async downloadSphere(userId: string, sphereId: string, status: SyncState, ignore: SyncIgnoreMap, domain : SyncDomain) : Promise<SyncRequestResponse_Sphere> {
    let includeArray = [];

    // if (!ignore.features) {
    //   includeArray.push({relation:'features'});
    // }
    if (!ignore.fingerprints) {
      includeArray.push({relation:'fingerprints'});
    }
    if (!ignore.locations) {
      includeArray.push({relation:'locations'});
    }
    if (!ignore.messages) {
      includeArray.push({relation:'messages', scope: { include: [
            {relation:'recipients', scope:{fields: { userId: true, messageId: true }}},
            {relation:'deletedBy',  scope:{fields: { createdAt:false }, where:{userId}}},
            {relation:'readBy',     scope:{fields: { createdAt:false }, where:{userId}}},
          ]}});
    }
    if (!ignore.hubs) {
      includeArray.push({relation:'hubs'});
    }
    if (!ignore.scenes) {
      includeArray.push({relation:'scenes'});
    }
    if (!ignore.stones) {
      let query = {};
      if (domain?.stones && domain.stones.length > 0) {
        query = {where: {id: {inq: domain.stones }}};
      }
      includeArray.push({relation:'stones', scope: {
          ...query,
          include: [
            {relation: 'behaviours'},
            {relation: 'abilities', scope: {include:[{relation:'properties'}]}},
            // {relation: 'currentSwitchState'},
          ]}
      });
    }
    if (!ignore.toons) {
      includeArray.push({relation:'toons'});
    }



    let sphereData;
    try {
      sphereData = await Dbs.sphere.findById(sphereId, {include: includeArray});
    }
    catch (err) {
      console.log("Error getting sphere data", err);
      return {};
    }

    /**
     * This function is a helper to insert the children of a sphere into a sphere.
     * @param sphere
     * @param key
     * @param sphereItem
     */
    function injectSphereSimpleItem(sphere: Sphere, key: SyncCategory, sphereItem: any) {
      // @ts-ignore
      if (sphere[key] !== undefined) {
        sphereItem[key] = {};
        // @ts-ignore
        for (let i = 0; i < sphere[key].length; i++) {
          // @ts-ignore
          let item = sphere[key][i];
          sphereItem[key][item.id] = {data: {status: status, data: item}};
        }
      }
    }

    let sphereItem : SyncRequestResponse_Sphere = {};
    if (!ignore.spheres) {
      sphereItem = { data: { status: status, data: {}}};
    }

    let sphereKeys = Object.keys(sphereData);
    for (let i = 0; i < sphereKeys.length; i++) {
      let key = sphereKeys[i];
      if (!ignore.spheres && sphereRelationsMap[key] === undefined) {
        // @ts-ignore
        sphereItem.data.data[key] = sphereData[key];
      }
    }

    // filter messages for this user
    if (!ignore.messages) {
      sphereData.messages = filterForMyMessages(sphereData.messages, userId);
    }

    injectSphereSimpleItem(sphereData, 'fingerprints',    sphereItem);
    injectSphereSimpleItem(sphereData, 'hubs',            sphereItem);
    // injectSphereSimpleItem(sphereData, 'features',        sphereItem);
    injectSphereSimpleItem(sphereData, 'messages',        sphereItem);
    injectSphereSimpleItem(sphereData, 'locations',       sphereItem);
    injectSphereSimpleItem(sphereData, 'scenes',          sphereItem);
    injectSphereSimpleItem(sphereData, 'toons',           sphereItem);

    if (!ignore.sphereUsers) {
      let sphereUsers = await SphereAccessUtil.getSphereUsersForSphere(sphereId);
      sphereItem.users = {}
      for (let userId in sphereUsers) {
        sphereItem.users[userId] = {data: { status: status, data: sphereUsers[userId]}}
      }
    }

    if (sphereData.stones !== undefined) {
      sphereItem.stones = {};
      for (let i = 0; i < sphereData.stones.length; i++) {
        let stone = {...sphereData.stones[i]};
        let stoneData = {...stone};
        delete stoneData['abilities'];
        delete stoneData['behaviours'];

        sphereItem.stones[stone.id] = {
          data: {status: status, data: stoneData},
        };
        let stoneReply : SyncResponseStone = sphereItem.stones[stone.id];

        if (stone.behaviours) {
          stoneReply.behaviours = {};
          for (let j = 0; j < stone.behaviours.length; j++) {
            let behaviour = stone.behaviours[j];
            stoneReply.behaviours[behaviour.id] = { data: {status: status, data: behaviour }}
          }
        }

        if (stone.abilities) {
          stoneReply.abilities = {};
          for (let j = 0; j < stone.abilities.length; j++) {
            let ability = stone.abilities[j];
            let abilityData = {...ability};
            delete abilityData.properties;
            stoneReply.abilities[ability.id] = { data: { status: status, data: abilityData }};

            if (ability.properties) {
              // @ts-ignore
              stoneReply.abilities[ability.id].properties = {};
              for (let k = 0; k < ability.properties.length; k++) {
                let property = ability.properties[k];
                // @ts-ignore
                stoneReply.abilities[ability.id].properties[property.id] = { data: { status: status, data: property }};
              }
            }
          }
        }
      }
    }

    return sphereItem;
  }


  async getBootloaders(userId: string, request: SyncRequest, user?: User) {
    if (!user) {
      user = await Dbs.user.findById(userId, {fields: {earlyAccessLevel: true}});
    }

    let appVersion = request?.sync?.appVersion ?? null;
    let hwVersions = hardwareVersions.util.getAllVersions();
    let accessLevel = user.earlyAccessLevel;
    let results = await Dbs.bootloader.find({where: {releaseLevel: {lte: accessLevel }}})
    let filteredResults : Bootloader[] = filterForAppVersion(results, appVersion);

    // generate a map of all bootloaders per hardware version.
    let bootloaderForHardwareVersions : {[hwVersion:string]: Bootloader[] } = sortByHardwareVersion(hwVersions, filteredResults)

    // pick the highest version per hardware type.
    let highestBootloaderVersions = getHighestVersionPerHardwareVersion(hwVersions, bootloaderForHardwareVersions)

    return highestBootloaderVersions;
  }


  async getFirmwares(userId: string, request: SyncRequest, user?: User) {
    if (!user) {
      user = await Dbs.user.findById(userId, {fields: {earlyAccessLevel: true}});
    }

    let appVersion = request?.sync?.appVersion ?? null;
    let hwVersions = hardwareVersions.util.getAllVersions();
    let accessLevel = user.earlyAccessLevel;
    let results = await Dbs.firmware.find({where: {releaseLevel: {lte: accessLevel }}});
    let filteredResults : Firmware[] = filterForAppVersion(results, appVersion);

    // generate a map of all bootloaders per hardware version.
    let firmwareForHardwareVersions : {[hwVersion:string]: Firmware[] } = sortByHardwareVersion(hwVersions, filteredResults)

    // pick the highest version per hardware type.
    let highestFirmwareVersions = getHighestVersionPerHardwareVersion(hwVersions, firmwareForHardwareVersions)

    return highestFirmwareVersions;
  }

  /**
   * This does a full grab of all syncable data the user has access to.
   * @param userId
   */
  async downloadAll(userId: string, request: SyncRequest, domain : SyncDomain) {
    let ignore = getSyncIgnoreList(request.sync.scope, domain);

    let reply : SyncRequestResponse = {
      spheres: {},
    };

    let user : User;
    if (!ignore.user) {
      user = await Dbs.user.findById(userId);
      reply.user = { status: "VIEW", data: user };
    }

    let access = await Dbs.sphereAccess.find({where: {userId: userId}, fields: {sphereId:true, userId: true, role:true}});

    for (let i = 0; i < access.length; i++) {
      let sphereId = access[i].sphereId;
      if (
        !domain || !domain.spheres ||
        domain.spheres &&
        (domain.spheres.length === 0 || (domain.spheres.length > 0 && domain.spheres.indexOf(sphereId) !== -1))) {
        reply.spheres[sphereId] = await this.downloadSphere(userId, sphereId, "VIEW", ignore, domain);
      }

      if (domain?.stones && domain.stones.length > 0) {
        // we only require certain stones, if these are not in the sphere, remove the sphere from the reply
        for (let sphereId in reply.spheres) {
          if (Object.keys(reply.spheres[sphereId]).length === 0) {
            delete reply.spheres[sphereId];
          }
        }
      }
    }

    if (!ignore.firmwares) {
      reply.firmwares = {
        status: "VIEW",
        data: {...await this.getFirmwares(  userId, request, user)}
      };
    }
    if (!ignore.bootloaders) {
      reply.bootloaders = {
        status: "VIEW",
        data: {...await this.getBootloaders(userId, request, user)}
      };
    }
    if (!ignore.keys) {
      reply.keys = {
        status: "VIEW",
        data: await getEncryptionKeys(userId, null, null, access)
      };
    }

    return reply;
  }


  async handleRequestSync(userId: string, request: SyncRequest, domain : SyncDomain) : Promise<SyncRequestResponse> {
    let ignore = getSyncIgnoreList(request.sync.scope, domain);

    // this has the list of all required connection ids as wel as it's own ID and the updatedAt field.
    let filterFields = {
      id:                 true,
      earlyAccessLevel:   true, // used for bootloaders and firmwares.
      updatedAt:          true,
      sphereId:           true,
      stoneId:            true,
      abilityId:          true
    };

    let access = await Dbs.sphereAccess.find({where: {userId: userId, invitePending: {neq: true}}});
    let sphereIds = [];
    let accessMap : {[sphereId: string]: ACCESS_ROLE} = {};

    for (let i = 0; i < access.length; i++) {
      let sphereId = access[i].sphereId;
      if (
        !domain ||
        !domain.spheres ||
        domain.spheres && (domain.spheres.length === 0 || (domain.spheres.length > 0 && domain.spheres.indexOf(String(sphereId)) !== -1))) {
        sphereIds.push(access[i].sphereId);

        accessMap[access[i].sphereId] = access[i].role as ACCESS_ROLE;
      }
    }

    let sphereData = await Dbs.sphere.find({where: {id: {inq: sphereIds}},fields: filterFields})

    // We do this in separate queries since Loopback also makes it separate queries and the fields filter for id an updated at true does
    // not work in the scope {}. It only supports fields filter where we remove fields. Go figure...

    // this list *should* be the same as the one we got from the access, but since this is a cheap check, we make sure we only query the
    // rest of the database for the spheres that we actually got back.
    sphereIds = getIds(sphereData);
    let filter : any = {where: {and: [{sphereId: {inq: sphereIds }}]}, fields: filterFields};
    // we make a copy and modify the filter for specific models.
    let messageFilter = Util.deepCopy(filter);
    messageFilter.fields = {
      id:                 true,
      updatedAt:          true,
      sphereId:           true,
      everyoneInSphere:   true,
      includeSenderInEveryone: true
    }
    messageFilter['include'] = [
      {relation:'recipients', scope:{fields: { userId: true, messageId: true }}},
      {relation:'deletedBy',  scope:{fields: { createdAt:false }, where:{userId}}},
      {relation:'readBy',     scope:{fields: { createdAt:false }, where:{userId}}},
    ]
    let stoneFilter = Util.deepCopy(filter);

    // Set the filter requirements for stone domain filters.
    if (domain && domain.stones) {
      stoneFilter.where.and.push({id: {inq: domain.stones}});
      filter.where.and.push({stoneId: {inq: domain.stones}});
    }


    // let featureData         = ignore.features     ? [] : await Dbs.sphereFeature.find(filter);
    let locationData        = ignore.locations    ? [] : await Dbs.location.find(filter);
    let fingerprintData     = ignore.fingerprints ? [] : await Dbs.fingerprintV2.find(filter);

    let messageData         = ignore.messages     ? [] : await Dbs.messageV2.find(messageFilter);
    if (!ignore.messages) {
      messageData = filterForMyMessages(messageData, userId);
    }
    let messageRecipientData : nestedIdArray<MessageRecipientUser> = mapMessageProperties(messageData, 'recipients');
    let messageDeletedByData : nestedIdMap<MessageDeletedByUser> = mapMessageMapProperties(messageData, 'deletedBy');
    let messageReadByData    : nestedIdMap<MessageReadByUser>    = mapMessageMapProperties(messageData, 'readBy');

    let hubData             = ignore.hubs         ? [] : await Dbs.hub.find(filter);
    let sceneData           = ignore.scenes       ? [] : await Dbs.scene.find(filter);

    let stoneData           = ignore.stones       ? [] : await Dbs.stone.find(stoneFilter);
    let behaviourData       = ignore.stones       ? [] : await Dbs.stoneBehaviour.find(filter)
    let abilityData         = ignore.stones       ? [] : await Dbs.stoneAbility.find(filter)
    let abilityPropertyData = ignore.stones       ? [] : await Dbs.stoneAbilityProperty.find(filter)

    let toonData            = ignore.toons           ? [] : await Dbs.toon.find(filter);

    let sphereUsers         = ignore.sphereUsers     ? {} : await SphereAccessUtil.getSphereUsers(sphereIds);

    // this is cheap to do with empty arrays do we don't check for ignore here.
    let cloud_spheres           = getUniqueIdMap(sphereData);
    // let cloud_features          = getNestedIdMap(featureData,         'sphereId');
    let cloud_locations         = getNestedIdMap(locationData,        'sphereId');
    let cloud_fingerprints      = getNestedIdMap(fingerprintData,     'sphereId');

    let cloud_messages          = getNestedIdMap(messageData,         'sphereId');

    let cloud_hubs              = getNestedIdMap(hubData,             'sphereId');
    let cloud_scenes            = getNestedIdMap(sceneData,           'sphereId');
    let cloud_stones            = getNestedIdMap(stoneData,           'sphereId');
    let cloud_behaviours        = getNestedIdMap(behaviourData,       'stoneId');
    let cloud_abilities         = getNestedIdMap(abilityData,         'stoneId');
    let cloud_abilityProperties = getNestedIdMap(abilityPropertyData, 'abilityId');
    let cloud_toons             = getNestedIdMap(toonData,            'sphereId');

    let reply : SyncRequestResponse = {spheres:{}};

    let creationMap : creationMap = {};
    if (request.spheres) {
      let requestSphereIds = Object.keys(request.spheres);
      for (let i = 0; i < requestSphereIds.length; i++) {
        let sphereId = requestSphereIds[i];
        let requestSphere = request.spheres[sphereId];
        reply.spheres[sphereId] = {};
        if (!ignore.spheres) {
          reply.spheres[sphereId].data = await getShallowReply(requestSphere.data, cloud_spheres[sphereId], () => {
            return Dbs.sphere.findById(sphereId)
          });
        }
        else {
          if (!cloud_spheres[sphereId]) {
            reply.spheres[sphereId].data = {status: "NOT_AVAILABLE"};
          }
        }

        let replySphere = reply.spheres[sphereId];

        if (replySphere?.data?.status === 'NOT_AVAILABLE') {
          continue;
        }

        let accessRole = accessMap[sphereId];

        let SphereSyncer = new Sync_SphereComponents(userId, sphereId, accessRole, creationMap, requestSphere, replySphere);

        // The order of syncing is important since some models might reference others
        // for example: a stone model has a field with locationId.
        // This means we first have to sync the locations, to ensure we have cloudIds for all local locationIds
        // so that we can replace the localIds with the cloudIds when storing a new stone.

        if (!ignore.locations) {
          await SphereSyncer.locations.processRequest(cloud_locations[sphereId]);
        }

        // if (!ignore.features) {
        //   await SphereSyncer.features.processRequest(cloud_features[sphereId]);
        // }

        if (!ignore.messages) {
          SphereSyncer.messages.loadChildData(messageRecipientData, messageReadByData, messageDeletedByData);
          await SphereSyncer.messages.processRequest(cloud_messages[sphereId]);
        }

        if (!ignore.fingerprints) {
          await SphereSyncer.fingerprints.processRequest(cloud_fingerprints[sphereId]);
        }

        if (!ignore.scenes) {
          await SphereSyncer.scenes.processRequest(cloud_scenes[sphereId]);
        }

        if (!ignore.toons) {
          await SphereSyncer.toons.processRequest(cloud_toons[sphereId]);
        }

        if (!ignore.stones) {
          SphereSyncer.stones.loadChildData(cloud_behaviours, cloud_abilities, cloud_abilityProperties);
          await SphereSyncer.stones.processRequest(cloud_stones[sphereId]);
        }

        if (!ignore.hubs) {
          await SphereSyncer.hubs.processRequest(cloud_hubs[sphereId]);
        }

        if (!ignore.sphereUsers) {
          await SphereSyncer.users.processRequest(sphereUsers[sphereId]);
        }

      }


      // now we will iterate over all spheres in the cloud
      // this handles:
      //  - cloud has sphere that the user does not know.
      for (let i = 0; i < sphereIds.length; i++) {
        let cloudSphereId = sphereIds[i];
        if (request.spheres[cloudSphereId] === undefined) {
          reply.spheres[cloudSphereId] = await this.downloadSphere(userId, cloudSphereId, "NEW_DATA_AVAILABLE", ignore, domain);
        }
      }
    }
    else {
      // there are no spheres for the user, give the user all the spheres.
      for (let i = 0; i < sphereIds.length; i++) {
        let cloudSphereId = sphereIds[i];
        reply.spheres[cloudSphereId] = await this.downloadSphere(userId, cloudSphereId, "NEW_DATA_AVAILABLE", ignore, domain);
      }
    }

    let user : User;
    if (!ignore.user && !domain) {
      user       = await Dbs.user.findById(userId, {fields: filterFields});
      reply.user = await getShallowReply(request.user, user, () => { return Dbs.user.findById(userId)})
    }

    if (!ignore.firmwares && !domain) {
      reply.firmwares = {
        status: "VIEW",
        data: {...await this.getFirmwares(  userId, request, user)}
      };
    }
    if (!ignore.bootloaders && !domain) {
      reply.bootloaders = {
        status: "VIEW",
        data: {...await this.getBootloaders(userId, request, user)}
      };
    }
    if (!ignore.keys && !domain) {
      reply.keys = {
        status: "VIEW",
        data: await getEncryptionKeys(userId, null, null, access)
      };
    }


    // Set the filter requirements for stone domain filters.
    if (domain && domain.stones) {
      for (let sphereId in reply.spheres) {
        if (reply.spheres[sphereId].stones === undefined) {
          delete reply.spheres[sphereId];
        }
      }
    }


    return reply;
  }


  /**
   * This method handles the TYPE=REPLY from the users. This is the second step in the syncing phase.
   * @param userId
   * @param request
   */
  async handleReplySync(userId: string, request: SyncRequest, domain : SyncDomain) {
    let ignore = getSyncIgnoreList(request.sync.scope, domain);

    let access = await Dbs.sphereAccess.find({where: {userId: userId, invitePending: {neq: true}}});
    let sphereIds = [];
    let accessMap: { [sphereId: string]: ACCESS_ROLE } = {};

    for (let i = 0; i < access.length; i++) {
      sphereIds.push(access[i].sphereId);
      accessMap[access[i].sphereId] = access[i].role as ACCESS_ROLE;
    }

    let reply : SyncRequestResponse = {spheres:{}};

    if (request.user) {
      try {
        await Dbs.user.updateById(userId, request.user, {acceptTimes: true});
        reply.user = {status: "UPDATED_IN_CLOUD"};
      }
      catch (err : any) {
        reply.user = {status: "ERROR", error: {code: err?.statusCode ?? 0, msg: err?.message ?? err}};
      }
    }

    if (request.spheres) {
      let requestSphereIds = Object.keys(request.spheres);
      for (let i = 0; i < requestSphereIds.length; i++) {
        let sphereId = requestSphereIds[i];
        let accessRole = accessMap[sphereId];
        let requestSphere = request.spheres[sphereId];
        reply.spheres[sphereId] = {};
        let replySphere = reply.spheres[sphereId];

        if (requestSphere.data) {
          // update model in cloud.
          if (accessRole !== 'admin' && accessRole !== 'member') {
            replySphere.data = {status: "ACCESS_DENIED"};
          }
          else {
            try {
              await Dbs.sphere.updateById(sphereId, requestSphere.data, {acceptTimes: true});
              replySphere.data = {status: "UPDATED_IN_CLOUD"};
              EventSphereCache.merge(sphereId, requestSphere.data);
              EventHandler.dataChange.sendSphereUpdatedEventBySphereId(sphereId);
            }
            catch (err : any) {
              replySphere.data = {status: "ERROR", error: {code: err?.statusCode ?? 0, msg: err?.message ?? err}};
            }
          }
        }

        let SphereSyncer = new Sync_SphereComponents(userId, sphereId, accessRole, {}, requestSphere, replySphere);
        await SphereSyncer.hubs.processReply();

        await SphereSyncer.locations.processReply();

        await SphereSyncer.scenes.processReply();

        await SphereSyncer.toons.processReply();

        await SphereSyncer.stones.processReply();
      }
    }

    return reply;
  }


  /**
   * This method will receive the initial sync request payload.
   *
   *
   * @param userId
   * @param dataStructure
   */
  async handleSync(userId: string, dataStructure: SyncRequest, domain : SyncDomain = null) : Promise<any | SyncRequestResponse> {

    if (!dataStructure || Object.keys(dataStructure).length === 0) {
      throw new HttpErrors.BadRequest("No sync information provided.");
    }

    // Full is used on login and is essentially a partial dump for your user
    if (dataStructure?.sync?.type === "FULL") {
      return this.downloadAll(userId, dataStructure, domain);
    }
    // Request is the first part of a real sync operation.
    else if (dataStructure?.sync?.type === "REQUEST") {
      // the user has sent a list of ids and updated at times. This should be the full set of what the user has
      // the cloud will query all ids that the user has access to including their updated at times.
      // there are 2 edge cases:
      //    1 - The user has an extra id: an entity has been created and not synced to the cloud yet.
      //            SOLUTION: It will be marked with new: true. The user knows that this is new since the user does not have a cloudId
      //    2 - The cloud has an id less: another user has deleted an entity from the cloud and this user doesnt know it yet.
      //            SOLUTION: the cloud marks this id as NOT_AVAILABLE
      // If we want to only query items that are newer, we would not be able to differentiate between deleted and updated.
      // To allow for this optimization, we should keep a deleted event.
      return this.handleRequestSync(userId, dataStructure, domain);
    }
    else if (dataStructure?.sync?.type === "REPLY") {
      // this phase will provide the cloud with ids and data. The cloud has requested this, we update the models with the new data.
      // this returns a simple 200 {status: "OK"} or something

      return this.handleReplySync(userId, dataStructure, domain);
    }
    else {
      throw new HttpErrors.BadRequest("Sync type required. Must be either REQUEST, REPLY or FULL")
    }
  }
}

function mapMessageProperties<T>(messages: MessageV2[], property : 'recipients' | 'readBy' | 'deletedBy') : nestedIdArray<T>{
  let result : any = {};
  for (let message of messages) {
    if (message[property] && message[property].length > 0) {
      result[message.id] = message[property];
    }
  }
  return result;
}

function mapMessageMapProperties<T>(messages: MessageV2[], property : 'recipients' | 'readBy' | 'deletedBy') : nestedIdMap<T>{
  let result : any = {};
  for (let message of messages) {
    for (let prop of (message[property] ?? [])) {
      if (result[message.id] === undefined) { result[message.id] = {}; }
      result[message.id][prop.id] = prop;
    }
  }
  return result;
}


export const SyncHandler = new Syncer();
