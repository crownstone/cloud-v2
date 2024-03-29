import {BelongsToAccessor, Getter, juggler, repository} from '@loopback/repository';
import { inject } from '@loopback/core';
import {SphereRepository} from "./sphere.repository";
import {SphereAccess} from "../../models/sphere-access.model";
import {Sphere} from "../../models/sphere.model";
import {TimestampedCrudRepository} from "../bases/timestamped-crud-repository";


export class SphereAccessRepository extends TimestampedCrudRepository<SphereAccess,typeof SphereAccess.prototype.id > {
  public readonly sphere: BelongsToAccessor<Sphere, typeof Sphere.prototype.id>;

  constructor(
    @inject('datasources.data') protected datasource: juggler.DataSource,
    @repository.getter('SphereRepository') sphereRepoGetter: Getter<SphereRepository>) {
    super(SphereAccess, datasource);
    this.sphere = this.createBelongsToAccessorFor('sphere', sphereRepoGetter);
  }

}
