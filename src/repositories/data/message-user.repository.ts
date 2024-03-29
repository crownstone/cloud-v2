import {BelongsToAccessor, Getter, juggler, repository} from '@loopback/repository';
import { inject } from '@loopback/core';
import { TimestampedCrudRepository } from "../bases/timestamped-crud-repository";
import {SphereRepository} from "./sphere.repository";
import {MessageRepository} from "./message.repository";
import {MessageUser} from "../../models/messageSubModels/message-user.model";
import {Sphere} from "../../models/sphere.model";
import {Message} from "../../models/message.model";
import {User} from "../../models/user.model";
import {UserRepository} from "../users/user.repository";


export class MessageUserRepository extends TimestampedCrudRepository<MessageUser,typeof MessageUser.prototype.id > {
  public readonly sphere:  BelongsToAccessor<Sphere,  typeof Sphere.prototype.id>;
  public readonly message: BelongsToAccessor<Message, typeof Message.prototype.id>;
  public readonly user:   BelongsToAccessor<User,    typeof User.prototype.id>;

  constructor(
    @inject('datasources.data') protected datasource: juggler.DataSource,
    @repository.getter('SphereRepository') sphereRepoGetter: Getter<SphereRepository>,
    @repository.getter('MessageRepository') messageRepoGetter: Getter<MessageRepository>,
    @repository.getter('UserRepository') userRepoGetter: Getter<UserRepository>) {
    super(MessageUser, datasource);
    this.sphere  = this.createBelongsToAccessorFor('sphere', sphereRepoGetter);
    this.message = this.createBelongsToAccessorFor('message', messageRepoGetter);
    this.user    = this.createBelongsToAccessorFor('user', userRepoGetter);
  }
}
