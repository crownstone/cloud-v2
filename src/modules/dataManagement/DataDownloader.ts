import {Dbs} from "../containers/RepoContainer";
import {GridFsUtil} from "../../util/GridFsUtil";
import {AccessLevels, SphereAccess} from "../../models/sphere-access.model";
import path from "path";
import {getEncryptionKeys} from "../sync/helpers/KeyUtil";
import {Device} from "../../models/device.model";
import {FingerprintLinker} from "../../models/fingerprint-linker.model";
import {Util} from "../../util/Util";
const AdmZip = require("adm-zip");

const THROTTLE_TIME = 5*60*1000; // 5 minutes;
const SESSION_LIMIT = 5;         // max consecutive sessions to download user data.

// this should be in a REDIS database.... for now it works since we have 1 instance.
export class UserDataManagementThrottleClass {

  userIds  : Record<string, number> = {};
  sessions : Record<string, number> = {};

  waitingSessions : Record<string, any> = {};
  waitingSessionsQueue : string[]       = [];


  allowUserSession(userId: string) : boolean {
    let lastTime = this.userIds[userId];
    if (!lastTime) { return true; }
    return Date.now() - lastTime > THROTTLE_TIME
  }

  async waitToInitiateSession(userId: string) : Promise<void> {
    return new Promise((resolve, reject) => {
      let cleanup = (err: string) => {
        this.waitingSessions[userId].reject(new Error(err))
        clearTimeout(this.waitingSessions[userId].timeout);
        let index = this.waitingSessionsQueue.indexOf(userId);
        if (index !== -1) { this.waitingSessionsQueue.splice(index,1); }
        delete this.waitingSessions[userId];
      }

      if (this.waitingSessions[userId]) {
        cleanup("ALREADY_IN_QUEUE");
      }

      let timeout = setTimeout(() => {
        cleanup("REQUEST_WAIT_TIMEOUT");
      }, 15000);

      this.waitingSessions[userId] = {resolve, reject, timeout};
      this.waitingSessionsQueue.push(userId);
    })
  }


  async startSession(userId: string) {
    if (Object.keys(this.sessions).length > SESSION_LIMIT) {
      await this.waitToInitiateSession(userId);
    }

    this.sessions[userId] = Date.now();
    this.userIds[userId]  = Date.now();
  }


  endSession(userId: string) {
    delete this.sessions[userId];

    let nextUserId = this.waitingSessionsQueue.shift();
    if (nextUserId) {
      this.waitingSessions[nextUserId].resolve();
      clearTimeout(this.waitingSessions[nextUserId].timeout);
      delete this.waitingSessions[nextUserId];
    }

    // delete old entries of the request method.
    let cutoff = Date.now() - THROTTLE_TIME;
    for (let userId in this.userIds) {
      if (this.userIds[userId] <= cutoff) {
        delete this.userIds[userId];
      }
    }
  }
}

export const UserDataDownloadThrottle = new UserDataManagementThrottleClass();


export class DataDownloader {
  userId: string;
  zipFile: any;


  constructor(userId: string) {
    this.userId = userId;
    this.zipFile = new AdmZip();
  }

  async download() {
    let startTime = Date.now()
    await UserDataDownloadThrottle.startSession(this.userId);

    try {
      let user = await Dbs.user.findById(this.userId);
      // download the user data
      this.addJson(user,'user', [],['password', 'earlyAccessLevel']);

      // add FW and BL data for possible imports.
      let firmwares   = await Dbs.firmware.find();
      let bootloaders = await Dbs.bootloader.find();

      this.addJson(firmwares,'firmwares', [],[]);
      this.addJson(bootloaders,'bootloaders', [],[]);

      // get the user profile picture
      await this.addFile(user.profilePicId, 'user profile picture');

      // download the Crownstone tokens belonging to this user
      let tokens = await Dbs.crownstoneToken.find({where: {userId: this.userId}});
      await this.addJson(tokens, 'tokens', []);

      // download the Crownstone tokens belonging to this user
      let oauthTokens = await Dbs.oauthToken.find({where: {userId: this.userId}});
      await this.addJson(oauthTokens, 'oauthTokens', []);

      // download all devices
      let devices = await find(Dbs.device,{
        where: {ownerId: this.userId },
        include: [
          {relation: 'installations'},
          {relation: 'preferences'},
          {relation: 'fingerprintLinks'},
        ]});

      this.addJson(devices,'devices');

      let deviceIds = devices.map((device: Device) => { return device.id; })
      let fingerprintLinks = await find(Dbs.fingerprintLinker,{where: {deviceId: {inq: deviceIds}}});
      let fingerprintIds = fingerprintLinks.map((fingerprintLink: FingerprintLinker) => { return fingerprintLink.fingerprintId; })

      // download all fingerprints
      let fingerprints = await find(Dbs.fingerprint,{where: {id: {inq: fingerprintIds}}});
      this.addJson(fingerprints,'fingerprints');

      let sphereAccess : SphereAccess[] = await find(Dbs.sphereAccess,{where: {userId: this.userId, invitePending: false}});
      this.addJson(sphereAccess,'sphereAccess');

      // download spheres (where member or admin)
      let spheresWithAccess : SphereAccess[] = await find(Dbs.sphereAccess,{
        where: {
          and: [
            {userId: this.userId}, {invitePending: false}, {role: {inq:[AccessLevels.admin, AccessLevels.member]}}
          ]
        }, fields:{sphereId:true, role:true}});
      let sphereIds = spheresWithAccess.map((data) => { return data.sphereId; })
      let roles     = spheresWithAccess.map((data) => { return data.role; })
      let spheres   = await find(Dbs.sphere,{where:{id:{inq: sphereIds}}});


      // get sphere contents
      for (let i = 0;  i < spheres.length; i++) {
        let sphere       = spheres[i];
        let roleInSphere = roles[i];
        let sphereId     = sphere.id;

        this.addJson(sphere, sphere.id + "_" + sphere.name, 'spheres');
        let sphereFolder = sanitizeFilename(sphere.id + "_" + sphere.name);

        // download all fingerprints
        let fingerprintsV2 = await find(Dbs.fingerprintV2,{where: {sphereId: sphereId}});
        this.addJson(fingerprintsV2,'fingerprintsV2', ['spheres', sphereFolder]);


        // get scenes
        let scenes = await find(Dbs.scene,{where:{sphereId: sphereId}});
        this.addJson(scenes, 'scenes', ['spheres', sphereFolder], [], (data) => {
          if (typeof data.data !== 'string') {
            data.data = JSON.stringify(data.data);
          }
          return data;
        });

        // get custom images
        for (let scene of scenes) {
          if (scene.customPictureId) {
            await this.addFile(scene.customPictureId, ['spheres', sphereFolder, 'images','scenes']);
          }
        }

        // get stones
        let stoneIds = (await find(Dbs.stone,{where:{sphereId: sphereId}, fields: {id: true}})).map((stone) => { return stone.id; })
        let stones = await find(Dbs.stone, {where: {id:{inq:stoneIds}}, include: [
            {relation: 'behaviours'},
            {relation: 'abilities', scope: {include:[{relation:'properties'}]}},
            {relation: 'switchStateHistory'},
            {relation: 'energyData'},
            {relation: 'energyDataProcessed'},
            {relation: 'energyMetaData'},
          ]});

        // map stones so we can easily look them up
        let stoneMap : any = {};
        for (let stone of stones) {
          // we stringify and parse to remove the Loopback checkers which remove the keys from this object
          // it would remove keys on stringification otherwise.
          stoneMap[stone.id] = JSON.parse(JSON.stringify(stone));
        }
        // inject keys into the stone
        if (roleInSphere === 'admin') {
          let keys = await find(Dbs.stoneKeys, {where: {stoneId: {inq: stoneIds}}});
          for (let key of keys) {
            let stoneId = key.stoneId;
            if (stoneMap[stoneId]) {
              if (!stoneMap[stoneId].keys) { stoneMap[stoneId].keys = []; }
              stoneMap[stoneId].keys.push(key);
            }
          }
        }

        // add to zip.
        for (let stoneId in stoneMap) {
          let stone = stoneMap[stoneId];

          if (stone.behaviours === undefined) {
            delete stone.behaviours;
          }
          if (stone.energyData === undefined) {
            delete stone.energyData;
          }
          if (stone.energyDataProcessed === undefined) {
            delete stone.energyDataProcessed;
          }
          if (stone.energyMetaData === undefined) {
            delete stone.energyMetaData;
          }

          this.addJson(stone, stone.id + '_' + stone.name, ['spheres', sphereFolder, 'crownstones'])
        }

        // get locations
        let locations = await find(Dbs.location, {where:{sphereId: sphereId}});
        for (let location of locations) {
          if (location.imageId) {
            await this.addFile(location.imageId, ['spheres', sphereFolder, 'images','locations']);
          }
        }
        this.addJson(locations, 'locations', ['spheres', sphereFolder]);
        // get hubs
        if (roleInSphere === 'admin') {
          this.addJson(await find(Dbs.hub, {where: {sphereId: sphereId}}), 'hubs', ['spheres', sphereFolder], ['token']);
        }
        // get toons
        this.addJson(await find(Dbs.toon, {where:{sphereId: sphereId}}), 'toons', ['spheres', sphereFolder]);

        // get sphere keys (you have access to)
        let keysForSphere = await getEncryptionKeys(this.userId, sphereId, null, [spheresWithAccess[i]]);
        if (keysForSphere.length === 1) {
          this.addJson(keysForSphere[0], 'keys', ['spheres', sphereFolder]);
        }

        // get messages (sent by you)
        let messages               = await find(Dbs.message,               {where:{and: [{sphereId: sphereId}, {ownerId: this.userId }]}});
        let messageState           = await find(Dbs.messageState,          {where:{and: [{sphereId: sphereId}, {userId:  this.userId }]}});
        let messageDeletedByUser   = await find(Dbs.messageDeletedByUser,  {where:{and: [{sphereId: sphereId}, {userId:  this.userId }]}});
        let messageReadByUser      = await find(Dbs.messageReadByUser,     {where:{and: [{sphereId: sphereId}, {userId:  this.userId }]}});
        let messageRecipientUser   = await find(Dbs.messageRecipientUser,  {where:{and: [{sphereId: sphereId}, {userId:  this.userId }]}});
        let messagesV2             = await find(Dbs.messageV2,             {where:{and: [{sphereId: sphereId}, {ownerId: this.userId }]}});

        this.addJson({...messages},             'messages',             ['spheres', sphereFolder]);
        this.addJson({...messageState},         'messageState',         ['spheres', sphereFolder]);
        this.addJson({...messageDeletedByUser}, 'messageDeletedByUser', ['spheres', sphereFolder]);
        this.addJson({...messageReadByUser},    'messageReadByUser',    ['spheres', sphereFolder]);
        this.addJson({...messageRecipientUser}, 'messageRecipientUser', ['spheres', sphereFolder]);
        this.addJson({...messagesV2},           'messagesV2',           ['spheres', sphereFolder]);

        await Util.wait(250);
      }
      let buffer = this.zipFile.toBuffer()
      return buffer;
    }
    catch (err) {
      console.log("ERROR", err)
    }
    finally {
      UserDataDownloadThrottle.endSession(this.userId);
      let duration = Date.now() - startTime;
      console.log("User-data: getting all datatook", duration, "ms");
    }
  }

  async addFile(fileId?: string, pathArray: string | string[] = []) {
    // this stringcast is required in case a fileId is a mongo ID object.
    if (fileId) {
      fileId = String(fileId);
      try {
        let fileData = await GridFsUtil.downloadFileFromId(fileId);

        let filePathArrayBase = ['data'];
        if (Array.isArray(pathArray)) {
          filePathArrayBase = filePathArrayBase.concat(pathArray);
        }
        else {
          filePathArrayBase.push(pathArray);
        }

        let filename = fileData.meta.filename.split("?r=")[0];
        let fileNameArr = filename.split(".");
        let fileDataPathArray = [...filePathArrayBase];
            fileDataPathArray.push(fileId + '.' + fileNameArr[fileNameArr.length-1]);

        let fileMetaPathArray = [...filePathArrayBase];
        fileMetaPathArray.shift()

        let filePath = path.join.apply(this,fileDataPathArray);

        // add file directly
        this.addJson({...fileData.meta}, fileId, fileMetaPathArray);
        this.addJson([...fileData.chunks], fileId + "_chunks", fileMetaPathArray);
        this.zipFile.addFile(filePath, fileData.data, "entry comment goes here");
      }
      catch (err) {
        console.log("Cloud not get file.", err, pathArray, fileId);
      }
    }
  }

  async addJson(data: any, filename: string, pathArray: string | string[] = [], hiddenFields: string[] = [], postProcessor: (data: any) => any = null) {
    if (!data) {
      console.log("No data to store", filename);
      return;
    }
    else if (Array.isArray(data)) {
      if (data.length === 0) { return; }
    }
    else if (typeof data === 'object') {
      if (Object.keys(data).length === 0) {
        return;
      }
    }

    let filenameCleaned = sanitizeFilename(filename);

    // some of these fields are removed by stringification from the loopback data object. we use this to add them back in.
    function insertHiddenFields(dataObj: any) {
      let stringifiedData = JSON.stringify(dataObj);

      if (hiddenFields.length > 0) {
        let dataObject = JSON.parse(stringifiedData);
        for (let field of hiddenFields) {
          if (dataObj[field]) {
            dataObject[field] = dataObj[field];
          }
        }
        stringifiedData = JSON.stringify(dataObject);
      }

      if (postProcessor) {
        let dataObject = JSON.parse(stringifiedData);
        dataObject = postProcessor(dataObject);
        stringifiedData = JSON.stringify(dataObject);
      }

      return JSON.parse(stringifiedData);
    }

    let stringifiedData;
    if (Array.isArray(data)) {
      let result = [];
      for (let i = 0; i < data.length; i++) {
        result.push(insertHiddenFields(data[i]));
      }
      stringifiedData = JSON.stringify(result, null, 2);
    }
    else {
      stringifiedData = JSON.stringify(insertHiddenFields(data), null, 2);
    }


    let filePathArray = ['data'];
    if (Array.isArray(pathArray)) {
      filePathArray = filePathArray.concat(pathArray);
    }
    else {
      filePathArray.push(pathArray);
    }

    filePathArray.push(`${filenameCleaned}.json`);

    let filePath = path.join.apply(this,filePathArray);
    this.zipFile.addFile(filePath, Buffer.from(stringifiedData, "utf8"))
  }

}


export function sanitizeFilename(filename: string) {
  let cleanRegex = /[^a-zA-Z0-9\s\-\._]/g;
  return filename.replace(cleanRegex, '');
}


async function find(model: any, query: any) : Promise<any[]> {
  let modelName = model.constructor.name;
  let startTime = Date.now();
  let data = await model.find(query);
  let duration = Date.now() - startTime;
  const used = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  // console.log(used,"MB for User-data: getting", data.length, "items from", modelName, "took", duration, "ms");
  return data;
}
