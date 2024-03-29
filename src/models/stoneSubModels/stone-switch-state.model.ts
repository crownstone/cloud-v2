import {belongsTo, model, property} from '@loopback/repository';
import {AddTimestamps} from "../bases/timestamp-mixin";
import {BaseEntity} from "../bases/base-entity";
import {Sphere} from "../sphere.model";
import {Stone} from "../stone.model";

@model({
  settings: {
    mongodb: {
      collection: 'SwitchState',
    }
  }})
export class StoneSwitchState extends AddTimestamps(BaseEntity) {

  @property({type: 'string', id: true})
  id: string;

  @property({type: 'date', defaultFn:'now'})
  timestamp: Date;

  @property({type: 'number', required: true})
  switchState: number;

  @belongsTo(() => Sphere, {name:'sphere'})
  sphereId: string;

  @belongsTo(() => Stone)
  stoneId: string;
}