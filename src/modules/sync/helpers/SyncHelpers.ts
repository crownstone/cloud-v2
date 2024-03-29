import {TimestampedCrudRepository} from "../../../repositories/bases/timestamped-crud-repository";
import {getReply} from "./ReplyHelpers";
import {processCreationMap} from "./SyncUtil";
import {ValidationErrorCode} from "../../../util/errors/ValidationError";


/**
 * This function will parse a
 * {
    [itemId: string]: RequestItemCoreType
   }
 * from a handleRequestSync and give it's reply. This has to be done a lot, so there are a lot of variables in here to avoid
 * code duplication.
 * @param fieldname              | This is the field in the sphere like 'hubs' and it uses this to populate the reply and search the request
 * @param db                     | This is the repository of the model that describes this category. It is used to get new data from when the client does not know the data, and used to insert data to.
 * @param creationAddition       | When the new data entry is created, not all linked ids might be in the data. This adds those. Think sphereId etc.
 * @param clientSource           | This is the parent of the category from the request. So if the field is hubs, the clientSource is a sphere sync request (thats where the fieldname comes from)
 * @param replySource            | This is the parent of where we're going to put the reply.
 * @param creationMap            | This is a lookup map for multiple linked new item id resolving.
 * @param role                   | The access role of the authenticated user in this sphere.
 * @param writePermissions       | This is a map of which access roles have the permission to write.
 * @param editPermissions        | This is a map of which access roles have the permission to edit.
 * @param cloud_items_in_sphere  | This is what the cloud has on this category in this sphere. So the hubs that belong to the sphere for example.
 * @param eventCallback          | This callback allows the syncing model to emit an SSE event when a new item is created in the cloud db.
 * @param syncClientItemCallback | This callback is used to handle nested fields. It is difficult to read but this avoids a lot of code duplication. Used for abilityProperties
 * @param syncCloudItemCallback  | This callback is used to explore nested fields when the cloud is providing the user with new data. Used for abilityProperties
 * @param markChildrenAsNew      | This callback is used to mark any nested fields as new if the parent is new.
 */
export async function processSyncCollection<T extends UpdatedAt, U extends RequestItemCoreType>(
  fieldname: DataCategory,
  db: TimestampedCrudRepository<any, any>,
  creationAddition: object,
  clientSource: any,
  replySource: any,
  creationMap: creationMap,
  role: ACCESS_ROLE,
  writePermissions: RolePermissions,
  editPermissions: RolePermissions,
  cloud_items_in_sphere : idMap<T> = {},
  eventCallback: (clientItem: U, item: T) => void,
  syncClientItemCallback?: (replyAtPoint: any, clientItem: any, id: string, cloudId: string) => Promise<void>,
  syncCloudItemCallback?: (replyAtPoint: any, cloudItem: T, cloudId: string) => Promise<void>,
  markChildrenAsNew?: (clientItem: any) => void
  ) {

  // create an object in the reply that we can write to.
  replySource[fieldname] = {};

  if (clientSource[fieldname]) {
    // we will first iterate over all hubs in the user request.
    // this handles:
    //  - user has one more than cloud (new)
    //  - user has synced data, or user has data that has been deleted.
    let clientItemIds = Object.keys(clientSource[fieldname]);
    for (let j = 0; j < clientItemIds.length; j++) {
      let itemId = clientItemIds[j];
      let cloudId = itemId;
      let clientItem = clientSource[fieldname][itemId];

      if (clientItem.new) {
        if (writePermissions[role] !== true) {
          replySource[fieldname][itemId] = { data: { status: "ACCESS_DENIED" } };
          continue;
        }

        if (markChildrenAsNew) {
          markChildrenAsNew(clientItem);
        }

        // create item in cloud.
        try {
          // this will search for any ids that are in this model which might refer to local ids of previously created models.
          // example: locationId is inside of the stone data. This method will change the local locationId to the new cloudId
          // if that location was made in this sync session.
          let updatedData = processCreationMap(creationMap, clientItem.data);
          // @ts-ignore
          let newItem = await db.create({...updatedData, ...creationAddition});
          cloudId = newItem.id;

          // if the creation has returned an already existing item due to uniqueness constrains, we have to take it out of the
          // cloudItems list.
          if (cloud_items_in_sphere[cloudId] !== undefined) {
            delete cloud_items_in_sphere[cloudId];
          }
          creationMap[itemId] = cloudId;
          eventCallback(clientItem, newItem);
          replySource[fieldname][itemId] = { data: { status: "CREATED_IN_CLOUD", data: newItem }}
        }
        catch (err : any) {
          if (err?.message === ValidationErrorCode && err.alternative !== null) {
            cloudId = err.alternative.id;
            creationMap[itemId] = cloudId;
            replySource[fieldname][itemId] = { data: { status: "ALREADY_IN_CLOUD", data: err.alternative }}
          }
          else {
            replySource[fieldname][itemId] = { data: { status: "ERROR", error: {code: err?.statusCode ?? 0, msg: err?.message ?? err} }}
          }
        }
      }
      else {
        // compare if everything is in sync
        replySource[fieldname][itemId] = { data: await getReply(clientItem, cloud_items_in_sphere[itemId], () => { return db.findById(itemId) })}
        if (replySource[fieldname][itemId].data.status === "NOT_AVAILABLE") {
          continue;
        }
        else if (replySource[fieldname][itemId].data.status === "REQUEST_DATA" && editPermissions[role] !== true) {
          replySource[fieldname][itemId].data.status = "IN_SYNC";
        }
      }

      if (syncClientItemCallback) {
        await syncClientItemCallback(replySource[fieldname][itemId], clientItem, itemId, cloudId);
      }
    }


    // now we will iterate over all items in the cloud
    // this handles:
    //  - cloud has item that the user does not know.
    let cloudItemIds = Object.keys(cloud_items_in_sphere);
    for (let j = 0; j < cloudItemIds.length; j++) {
      let cloudItemId = cloudItemIds[j];
      if (clientSource[fieldname][cloudItemId] === undefined) {
        // reply with the data!
        replySource[fieldname][cloudItemId] = { data: await getReply(null, cloud_items_in_sphere[cloudItemId],() => { return db.findById(cloudItemId) })};
        if (syncCloudItemCallback) {
          await syncCloudItemCallback(replySource[fieldname][cloudItemId], cloud_items_in_sphere[cloudItemId], cloudItemId);
        }
      }
    }
  }
  else {
    // there are no items for the user, give the user all the items.
    let cloudItemIds = Object.keys(cloud_items_in_sphere);
    for (let j = 0; j < cloudItemIds.length; j++) {
      let cloudItemId = cloudItemIds[j];
      replySource[fieldname][cloudItemId] = { data: await getReply(null, cloud_items_in_sphere[cloudItemId],() => { return db.findById(cloudItemId) })};
      if (syncCloudItemCallback) {
        await syncCloudItemCallback(replySource[fieldname][cloudItemId], cloud_items_in_sphere[cloudItemId], cloudItemId);
      }
    }
  }
}
