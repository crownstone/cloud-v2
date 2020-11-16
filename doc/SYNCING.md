# crownstone-cloud-v2

# Syncing algorithm

The app has a local snapshot of this data and it can be out of sync. There are multiple users in a sphere that can change data like names of crownstones etc.


Syncing 
The old syncing mechanism is RESTful, each sphere GETS sphere, GETS their stones, each stone GETS their behaviours etc. This results in about 80 calls per user per sync if they have a lot of crownstones. (probably about 200 calls for Peet).

Every call has overhead, introduces delays in the app and this causes the sync to take sometimes minutes!

The new approach
I want to have 1 sync endpoint on a user. This endpoint will be called a maximum of 2 times per sync.

The app (or anything else that wishes to keep their local crownstone state in sync) will do a first request.

Full data model of the request here:
../src/declarations/declarations.d.ts#L13

I want to focus on the top of the request payload:
```
sync: {
    type: SyncPhase,
    lastTime: Date,
  }
```

With SyncType:
"FULL"      	
will just get your spheres and user.
"REQUEST"  	
 initial phase of sync
“REPLY” 
Wrap up phase of sync where the user will give the cloud any data that the cloud has requested with REQUEST_DATA(optional)

FULL is used for login etc.

Request is the first step of the sync process. The app will send a tree structure with categories (sphere, stone, etc), their ids and an updatedAt time.

The cloud will get (from all models the user has access to) the updatedAt times it knows.
It will then start to correspond the ids the user provided with the ones it found. It will also check the timestamps to see if the data is in sync, cloud has newer, or user has newer data.

After which, the cloud will send it’s reply:
../src/declarations/syncTypes.ts#L18

Each field has a status, and optionally data.

The status is one of these options:
- "DELETED" 
this entity has been deleted
- "IN_SYNC" 
same updatedAt time
- "NEWER_DATA_AVAILABLE" 
cloud has newer data (HAS DATA)
- "REQUEST_DATA" 
you have newer data, please give to cloud.
- “VIEW"	
you have requested data, here it is. No syncing information.  (HAS DATA)
- "CREATED_IN_CLOUD"
 the cloud has an additional id other than what you requested
- "ERROR"
 Something went wrong with this part of the query.
 - "ACCESS_DENIED"
 You tried to create a new field but you dont have access.
 

The user has sent a list of ids and updated at times. This should be the full set of what the user has and the cloud will query all ids that the user has access to including their updated at times.

There are 2 edge cases:
The user has an extra id: an entity has been created and not synced to the cloud yet.
SOLUTION: It will be marked with new: true. The user knows that this is new since the user does not have a cloudId
 The cloud has an id less: another user has deleted an entity from the cloud and this user doesnt know it yet.
the cloud marks this id as DELETED


## Future optimizations
#### Profile and index the database accordingly.
This is the first step to ensure that these queries are fast.

#### Only query newer data 
Requires adding DELETED events
This process is expensive in that it has to query all ids belonging to the user in order to check their times. If we want to only query items that are newer, we would not be able to differentiate between deleted and updated. To allow for this optimization, we could keep a deleted event.

#### Shorten the keywords
We can change updatedAt to t, etc. This will greatly shrink the payload size towards the cloud.

#### Store change times per branch
We can have the sphere have changedTimes per branch (locations, stones etc) of the tree. That way we only have to query those to see if there is a change. We would introduce a branchInSync field to each branch. This avoids us going down that branch.

#### Use the lastTime in the sync payload
If we have the times per branch, we can compare this with the last sync time and not even go into the request data model. (minor optimization)

#### Add a “PROBE” step
Here we would add an additional step to the sync where the user only sends the lastTime and type to the cloud and the cloud can query it’s branch change fields to see if there is newer data.

#### (Storing change events)
We could store change events to improve the probe step, except these may stack up. It can be annoying to keep track of when we can delete them safely. Working with these events as opposed to the branch times might introduce more (!) edge cases.

#### Cache the bootloader and firmware database in memory
This is a small bit of data and saves a few DB calls. We could update this every 30 minutes, and on invocation of change calls or something.

#### Keep a 2 second cache of sync data to be able to safer handle reply phases (actually check the times again)
