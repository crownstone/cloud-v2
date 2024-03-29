export const TransformUtil = {

  transformDataset(dataset: number[], transformSet: TransformSet) : number[] {
    let transformedDataset = [];
    for (let rssi of dataset) {
      let factor = TransformUtil.getInterpolatedValue(rssi, transformSet) ?? 1;
      transformedDataset.push(rssi * factor);
    }
    return transformedDataset;
  },

  /**
   * loop over the bucketedAverages and if there is no data in the bucket, linearly interpolate between the previous and next buckets.
   * If there is no data in the previous bucket, interpolate between the next and the one after that.
   * If there is no data in the next bucket, use the previous bucket and the one before that.
   * If there is no data in either, use 1.
   * @param bucketedAverages
   //  */
  getInterpolatedValues(transformSet : TransformSet) : TransformSet {
    let interpolatedValues : TransformSet = [];
    for (let i = 0; i < transformSet.length; i++) {
      if (transformSet[i].data[0] === null) {
        let target = transformSet[i].x;
        interpolatedValues.push({x:target, data: [target, TransformUtil.getInterpolatedValue(target, transformSet) ?? 1]});
      }
    }
    return interpolatedValues;
  },


  getTransFormSet(sets_From:MeasurementMap[], sets_To:MeasurementMap[]) : TransformSet {
    let comparisonArray : TransformArray = [];
    for (let i = 0; i < sets_From.length; i++) {
      let rawMap = TransformUtil.getRawMap_AtoB(sets_From[i], sets_To[i])
      comparisonArray = comparisonArray.concat(rawMap);
    }
    let normalizedMap = TransformUtil.getNormalizedMap(comparisonArray);
    normalizedMap.sort((a,b) => { return b[0] - a[0]; });


    let buckets            = TransformUtil.getBuckets();
    let bucketedData       = TransformUtil.fillBuckets(buckets, normalizedMap);
    let bucketedAverages   = TransformUtil.getAveragedBucketMap(bucketedData);
    let interpolatedValues = TransformUtil.getInterpolatedValues(bucketedAverages);

    let transformSet = [...bucketedAverages, ...interpolatedValues].filter((item) => { return item.data[0] !== null });
    transformSet.sort((a,b) => { return b.x - a.x });

    return transformSet;
  },


  getBucketIndexForValue(target: number, transformSet: TransformSet) : number {
    // find in which bucket the target is
    let currentBucketIndex = 0;
    for (let i = 0; i < transformSet.length; i++) {
      if (i == 0 && target > transformSet[i].x) {
        currentBucketIndex = i;
        break;
      }
      else if (i == transformSet.length - 1 && target <= transformSet[i].x) {
        currentBucketIndex = i;
        break;
      }
      else if (transformSet[i+1].x < target && transformSet[i].x >= target) {
        currentBucketIndex = i;
        break;
      }
    }
    return currentBucketIndex;;
  },


  getInterpolatedValue(targetX : number, transformSet: TransformSet) : number | null {
    let currentBucketIndex = TransformUtil.getBucketIndexForValue(targetX, transformSet);

    // check if the target is on the bucketValue or in between two buckets
    if (transformSet[currentBucketIndex].data[0] === targetX) {
      return transformSet[currentBucketIndex].data[1];
    }

    // check if we have data in a previous bucket
    let previousValue = TransformUtil.findPreviousValue(transformSet, targetX);
    let nextValue     = TransformUtil.findNextValue(transformSet, targetX);

    if (!previousValue && !nextValue) {
      // no data is found.
      return null;
    }
    else if (previousValue === null) {
      // find 2 buckets in the future
      let nextNextValue = TransformUtil.findNextValue(transformSet, nextValue[0]);
      if (!nextNextValue) { return nextValue[1] }
      else {
        return TransformUtil.interpolate(nextValue, nextNextValue, targetX);
      }
    }
    else if (nextValue === null) {
      // find a single bucket in the future and interpolate
      // find another previous value and interpolate
      let previousPreviousValue = TransformUtil.findPreviousValue(transformSet, previousValue[0]);
      if (!previousPreviousValue) { return previousValue[1] }
      else {
        return TransformUtil.interpolate(previousValue, previousPreviousValue, targetX);
      }
    }
    else {
      return TransformUtil.interpolate(nextValue, previousValue, targetX);
    }
  },

  interpolate(a:number[], b:number[], target: number) : number {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let slope = dy / dx;
    let distanceToTarget = target - a[0];
    return a[1] + slope * distanceToTarget;
  },



  getAveragedBucketMap(bucketedData: BucketedData[]) : AveragedBucketedData[] {
    // average the data in the buckets

    // Calculate average as iBeacon spec calibrates the rssi at one meter:
    // Remove the top 10%, remove the bottom 20%, and average the remaining values
    let bucketedAverages : Record<string,TransformData> = {};
    for (let key in bucketedData) {
      let bucketStart = bucketedData[key].x;
      let data = bucketedData[key].data;
      if (data.length === 0) {
        bucketedAverages[bucketStart] = [null,null];
        continue;
      }
      let distances = data.map((d, i) => [d[0],d[1],Math.abs(d[0] - d[1]),i]);
      if (distances.length >= 3) {
        // sort by distance
        distances.sort((a,b) => a[2] - b[2]);
        let startIndex = Math.ceil(distances.length / 5)
        let endIndex = Math.floor(distances.length - (distances.length / 10));
        let sliced = distances.slice(startIndex, endIndex);
        if (sliced.length > 0) {
          // calculate average
          let keySum = 0
          let sum = 0;
          for (let i = 0; i < sliced.length; i++) {
            keySum += sliced[i][0];
            sum += sliced[i][1];
          }
          bucketedAverages[bucketStart] = [keySum/sliced.length, sum / sliced.length];
        }
        else {
          // get the median from the unsliced array
          let medianIndex = Math.floor(distances.length / 2);
          let median = distances[medianIndex];
          bucketedAverages[bucketStart] = [median[0], median[1]];
        }
      }
      else {
        let keySum = 0
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          keySum += data[i][0];
          sum += data[i][1];
        }
        bucketedAverages[bucketStart] = [keySum/data.length, sum / data.length];
      }

    }

    let result : AveragedBucketedData[] = [];
    for (let bucket in bucketedAverages) {
      result.push({x: parseInt(bucket), data: bucketedAverages[bucket]});
    }

    return result;
  },


  /**
   * go through the buckets and fill them with the data points that fall within that bucket
   *
   * @param buckets
   * @param transformMap
   */
  fillBuckets(buckets: number[], transformMap: TransformArray) : BucketedData[] {
    let bucketedData : Record<string, [number, number][]> = {};
    let bucketSize = buckets[0] - buckets[1]; // (-50) - (-55) = 5
    for (let i = 0; i < buckets.length; i++) {
      let bucket = buckets[i];
      bucketedData[bucket] = [];
      for (let j = 0; j < transformMap.length; j++) {
        let diff = transformMap[j];
        if (diff[0] <= bucket && diff[0] > bucket - bucketSize) {
          bucketedData[bucket].push(diff);
        }
      }
    }

    let result : BucketedData[] = [];
    for (let bucket in bucketedData) {
      result.push({x: parseInt(bucket), data: bucketedData[bucket]});
    }

    return result;
  },

  getBuckets() : number[] {
    let bucketSize = 7; // dB
    let buckets = [];
    let start = -10;
    for (let i = start; i >= -95; i -= bucketSize) {
      buckets.push(i);
    }
    return buckets;
  },

  getRawMap_AtoB(mapA: MeasurementMap, mapB: MeasurementMap) : TransformArray {
    let transformMap : [fromRssi:number, factor:number][] = [];
    for (let key in mapA) {
      if (mapB[key]) {
        transformMap.push([mapA[key], mapB[key]]);
      }
    }
    transformMap.sort((a,b) => { return b[0] - a[0] });
    return transformMap;
  },

  getNormalizedMap(transformMap: TransformArray) : TransformArray {
    let normalizedMap : TransformArray = [];
    for (let value of transformMap) {
      normalizedMap.push([value[0], value[1]/value[0]])
    }
    return normalizedMap;
  },


  findNextValue(arr : TransformSet, targetX: number) : [x: number, y: number] | null {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].data[0] !== null && arr[i].data[0] < targetX) {
        return arr[i].data;
      }
    }
    return null;
  },


  findPreviousValue(arr : TransformSet, targetX: number) : [x: number, y: number] | null {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].data[0] !== null && arr[i].data[0] > targetX) {
        return arr[i].data;
      }
    }
    return null;
  },
}
