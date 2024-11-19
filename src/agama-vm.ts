#! /usr/bin/env node

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { program } from "commander";

// define command line arguments
program
  .description("Start an Agama instance in a VM")
  .requiredOption("-i, --iso <iso>", "ISO image to boot");

program.parse();
const options = program.opts();

let tmpdir;
try {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "agama-vm-"));

  // create sparse file for the raw disk image
  const disk = path.join(tmpdir, "disk");
  spawnSync("truncate", ["-s", "50G", disk])

  console.log("Starting Agama VM...\n");
  console.log("Connect to https://localhost:4433");
  console.log("Or use \"ssh root@localhost -p 2222\"");
  
  spawnSync("qemu-kvm", [
    "-m",
    "2G",
    "-smp",
    "4",
    "-boot",
    "d",
    "-drive",
    `format=raw,file=${disk}`,
    "-nic",
    // forward HTTPS (433) to local port 4433
    // forward SSH (22) to local port 2222
    "user,hostfwd=tcp::4433-:443,hostfwd=tcp::2222-:22",
    "-cdrom",
    options.iso,
  ]);
} finally {
  if (tmpdir) {
    fs.rmSync(tmpdir, { recursive: true });
  }
}
