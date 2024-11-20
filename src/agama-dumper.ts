#! /usr/bin/env node

import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

// since Node v22 it is possible to use a builtin function from "node:fs", but to be compatible with
// Node v20 in SLE15/Leap15 use an external NPM package
import { globSync } from "glob";
import { program } from "commander";
import { question } from "readline-sync";

// define command line arguments
program
  .description("Dump the current Agama REST API data")
  .requiredOption("-a, --api <dir>", "Agama OpenAPI specification")
  .option("-d, --debug", "Enable debugging")
  .option("-u, --url <url>", "Agama server URL", "http://localhost")
  .option("-p, --password <password>", "Agama login password")
  .option("-o, --output <file>", "Save output to file (default: stdout)");

program.parse();
const options = program.opts();

// read the password from terminal if not specified from command line
if (!options.password) {
  options.password = question(`Enter login password for Agama at ${options.url}: `, {
    // do not print the entered password in the terminal
    hideEchoBack: true,
    mask: "",
  });
}

// print a warning on stderr
function warn(msg: string) {
  process.stderr.write(msg);
  process.stderr.write("\n");
}

// helper function, login to Agama, resolves to the Agama authentication token
async function login(url: string, password: string): Promise<string> {
  const downloader = url.startsWith("https://") ? https : http;
  const loginData = JSON.stringify({ password });

  const options = {
    // ignore HTTPS errors (self-signed certificate)
    rejectUnauthorized: false,
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  };

  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    const req = downloader.request(url + "/api/auth", options, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject("Login failed");
        } else {
          const data = JSON.parse(chunks.join(""));
          resolve(data.token);
        }
      });
    });

    req.on("error", (e) => {
      reject(e.message);
    });

    // write request body
    req.write(loginData);
    req.end();
  });
}

async function api(url: string, token: string): Promise<any> {
  const downloader = url.startsWith("https://") ? https : http;
  const httpOptions = {
    // ignore HTTPS errors (self-signed certificate)
    rejectUnauthorized: false,
    headers: {
      authorization: "Bearer " + token,
    },
  };

  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    const req = downloader.get(url, httpOptions, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          if (options.debug) warn(`HTTP code ${res.statusCode}, response: ${chunks.join("")}`);
          reject("Download failed");
        } else {
          if (res.headers["content-type"] === "application/json") {
            const data = JSON.parse(chunks.join(""));
            resolve(data);
          } else {
            warn(`Ignoring ${res.headers["content-type"]} content`);
            resolve(null);
          }
        }
      });
    });

    req.on("error", (e) => {
      reject(e.message);
    });
  });
}

// special handling for paths with parameters
async function specialPaths(data: any, url: string, token: string) {
  const connectionPath = "/api/network/connections";
  const networkConnections = data[connectionPath];

  if (networkConnections) {
    for (const idx in networkConnections) {
      if (networkConnections[idx].id) {
        const path = connectionPath + "/" + networkConnections[idx].id;
        warn(`Downloading ${path}`);
        const res = await api(url + path, token);
        data[path] = res;
      }
    }
  }

  const storageParamsPath = "/api/storage/product/params";
  const storageParams = data[storageParamsPath];

  if (storageParams && storageParams.mountPoints) {
    const volumePath = "/api/storage/product/volume_for";
    const mountPoints = storageParams.mountPoints;

    // FIXME: the web UI additionally queries the empty path, is that OK?
    mountPoints.push("");
    for (const idx in mountPoints) {
      const path = volumePath + "?mount_path=" + encodeURIComponent(mountPoints[idx]);
      warn(`Downloading ${path}`);
      const res = await api(url + path, token);
      data[path] = res;
    }
  }
}

function sanityCheck(data: any) {
  const config = data["/api/software/config"];
  if (!config || !config.product) {
    warn(
      "WARNING: No product is selected, some settings (storage, software) depend on selected product."
    );
  }
}

// ignore these paths
const skip = [
  // FIXME: returns error 404, invalid OpenAPI?
  "/api/product/issues/product",
  // needs "id" parameter
  "/api/network/connections/:id",
  // needs "mount_path" query parameter
  "/api/storage/product/volume_for",
];

// extra paths missing in the OpenAPI data
// FIXME: add the missing data
const extra = ["/api/software/issues/product"];

// these paths return localized data (i.e. depending on the current UI language)
// TODO: add some flag to the OpenAPI data to avoid this hard coded list?
const localized = [
  "/api/l10n/keymaps",
  "/api/l10n/locales",
  "/api/l10n/timezones",
  "/api/software/patterns",
  "/api/software/products",
  "/api/storage/devices/result",
  "/api/storage/proposal/actions",
  "/api/users/issues",
];

async function supported(url: string, storage: string, token: string, data: any): Promise<boolean> {
  const path = `/api/storage/${storage}/supported`;
  const supported = await api(url + path, token);
  data[path] = supported;
  return supported;
}

async function apiDownload(
  url: string,
  path: string,
  token: string,
  data: any,
  language?: string
) {
  warn(`Downloading ${path}`);
  // remove trailing slash from path
  const requestPath = path.replace(/\/$/, "");
  const res = await api(url + requestPath, token);

  if (language) {
    if (!data[language]) {
      data[language] = {};
    }
    data[language][requestPath] = res;
  } else {
    data[requestPath] = res;
  }
}

async function extraPaths(data: any, url: string, token: string) {
  for (const idx in extra) {
    await apiDownload(url, extra[idx], token, data);
  }
}

async function switchLanguage(url: string, token: string, language: string) {
  const downloader = url.startsWith("https://") ? https : http;
  const options = {
    // ignore HTTPS errors (self-signed certificate)
    rejectUnauthorized: false,
    headers: {
      "Content-Type": "application/json",
      authorization: "Bearer " + token,
    },
    method: "PATCH",
  };

  return new Promise((resolve, reject) => {
    const req = downloader.request(url + "/api/l10n/config", options, (res) => {
      res.on("data", () => {});
      res.on("end", () => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          reject("Changing language failed");
        } else {
          resolve(null);
        }
      });
    });
    req.on("error", (e) => {
      reject(e.message);
    });

    // write request body
    const body = JSON.stringify({ uiLocale: language });
    req.write(body);
    req.end();
  });
}

async function localizedPaths(data: any, url: string, token: string) {
  const path = "/languages.json";
  warn(`Downloading ${path}`);
  const languages = await api(url + path, token);

  for (const language in languages) {
    const [lang, country] = language.split("-", 2);
    const uiLanguage = lang + "_" + country + ".UTF-8";
    warn("Switching UI language to " + uiLanguage);
    await switchLanguage(url, token, uiLanguage);

    for (const idx in localized) {
      await apiDownload(url, localized[idx], token, data, language);
    }
  }
}

async function readOpenAPI(dir: string, url: string, password: string) {
  const token = await login(url, password);
  const files = globSync("*.json", { cwd: dir });
  let data: any = {};

  // check if ZFCP and DASD devices are supported (S390 mainframe only)
  const zfcp = await supported(url, "zfcp", token, data);
  const dasd = await supported(url, "dasd", token, data);

  for (const idx in files) {
    const fullPath = path.join(dir, files[idx]);
    const apiData = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    const paths = apiData.paths || {};
    for (const name in paths) {
      if (paths[name].get) {
        if (
          skip.includes(name) ||
          localized.includes(name) ||
          (!zfcp && name.match(/zfcp/)) ||
          (!dasd && name.match(/dasd/))
        ) {
          warn(`Skipping ${name}`);
        } else {
          await apiDownload(url, name, token, data);
        }
      }
    }
  }

  await specialPaths(data, url, token);
  await extraPaths(data, url, token);
  await localizedPaths(data, url, token);

  // pretty print with 2 spaces indentation
  const result = JSON.stringify(data, null, 2);

  if (options.output) {
    fs.writeFileSync(options.output, result);
  } else {
    console.log(result);
  }

  sanityCheck(data);
}

// await cannot be used at the top level, define an anonymous async function and execute it
(async () => {
  try {
    await readOpenAPI(options.api, options.url, options.password);
  } catch (error) {
    warn(String(error));
    if (options.debug) {
      // print debug backtrace
      throw new Error("Agama dump failed", { cause: error });
    } else {
      process.exit(1);
    }
  }
})();
