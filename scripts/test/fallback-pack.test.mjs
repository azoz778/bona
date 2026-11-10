import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");

test("licence-free fallback candidate pack is complete and remains approval-gated",()=>{
  const output=execFileSync(process.execPath,["scripts/social/validate-fallback-pack.mjs"],{
    cwd:root,
    encoding:"utf8",
  });
  assert.match(output,/PASS: 7 dates, 14 candidate posts, 14 JPEGs, 7 exact caption files, 2 contact sheets\./);
  assert.match(output,/State: pending-owner; no publish or schedule authorization\./);
});

test("fallback validation rejects any extra rendered-asset directory entry",()=>{
  const extra=path.join(root,"public/social/fallback-20261005/unexpected.png");
  fs.writeFileSync(extra,"not a pack asset");
  try{
    assert.throws(()=>execFileSync(process.execPath,["scripts/social/validate-fallback-pack.mjs"],{
      cwd:root,
      encoding:"utf8",
      stdio:"pipe",
    }),/Command failed/);
  }finally{
    fs.rmSync(extra,{force:true});
  }
});

test("fallback validation rejects non-file rendered-asset entries",()=>{
  const extra=path.join(root,"public/social/fallback-20261005/unexpected-directory");
  fs.mkdirSync(extra);
  try{
    assert.throws(()=>execFileSync(process.execPath,["scripts/social/validate-fallback-pack.mjs"],{
      cwd:root,
      encoding:"utf8",
      stdio:"pipe",
    }),/Command failed/);
  }finally{
    fs.rmSync(extra,{recursive:true,force:true});
  }
});
