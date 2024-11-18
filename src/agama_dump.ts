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
  .description("Dump Agama REST API data")
  .requiredOption("-a, --api <dir>", "Agama OpenAPI specification")
  .option("-d, --debug", "Enable debugging")
  .option("-u, --url <url>", "Agama server URL", "http://localhost")
  .option("-p, --password <password>", "Agama login password")
  .option("-o, --output <file>", "Save output to file (default: stdout)");

program.parse();
const options = program.opts();

// read the password from terminal if not specified from command line
if (!options.password) {
  options.password = question(
    `Enter login password for Agama at ${options.url}: `,
    {
      // do not print the entered password in the terminal
      hideEchoBack: true,
      mask: "",
    }
  );
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
    const chunks = [];
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
    const chunks = [];
    const req = downloader.get(url, httpOptions, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          if (options.debug)
            process.stderr.write(
              `HTTP code ${res.statusCode}, response: ${chunks.join("")}\n`
            );
          reject("Download failed: " + chunks.join(""));
        } else {
          if (res.headers["content-type"] === "application/json") {
            const data = JSON.parse(chunks.join(""));
            resolve(data);
          } else {
            process.stderr.write(
              `Ignoring ${res.headers["content-type"]} content\n`
            );
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

async function readOpenAPI(dir: string, url: string, password: string) {
  const token = await login(url, password);
  const files = globSync("*.json", { cwd: dir });
  const data = {};

  for (const idx in files) {
    const fullPath = path.join(dir, files[idx]);
    const apiData = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    const paths = apiData.paths || {};
    for (const name in paths) {
      if (paths[name].get) {
        const params = paths[name].get.parameters;
        if (params && params.filter((p: any) => p.required).length > 0) {
          process.stderr.write(`Skipping ${name}\n`);
        } else {
          process.stderr.write(`Downloading ${name}\n`);
          try {
            const res = await api(url + name, token);
            data[name] = res;
          } catch (error) {
            // ignore zfcp endpoint errors
            // if (name.match(/zfcp/)) {
            //   console.log(`Ignoring ${name} error`);
            // } else {
            //   throw error;
            // }
          }
        }
      }
    }
  }

  // pretty print with 2 spaces indentation
  const result = JSON.stringify(data, null, 2);

  if (options.output) {
    fs.writeFileSync(options.output, result);
  } else {
    console.log(result);
  }
}

// await cannot be used at the top level, define an anonymous async function and execute it
(async () => {
  try {
    await readOpenAPI(options.api, options.url, options.password);
  } catch (error) {
    process.stderr.write(error);
    process.stderr.write("\n");
    if (options.debug) {
      // print debug backtrace
      throw new Error("Agama dump failed", { cause: error });
    } else {
      process.exit(1);
    }
  }
})();
