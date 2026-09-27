import test from "node:test";
import assert from "node:assert/strict";
import {bestPhotos} from "../social/lib/photos.mjs";
test("explicit social photo curation rejects invalid and duplicate indices before fetching", async()=>{
 for (const socialPhotoIndices of [[],[0,0],[-1],[2],["0"]]) {
  await assert.rejects(bestPhotos({id:"example",images:[{src:"https://example.invalid/photo.jpg"}],socialPhotoIndices}),/Invalid socialPhotoIndices/);
 }
});
