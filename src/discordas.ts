/*
Copyright 2017 - 2019 matrix-appservice-discord

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
import { Appservice, IAppserviceRegistration, LogService } from "matrix-bot-sdk";
import * as yaml from "js-yaml";
import * as fs from "fs";
import { DiscordBridgeConfig } from "./config";
import { DiscordBot } from "./bot";
import { DiscordStore } from "./store";
import { Log } from "./log";
import "source-map-support/register";
import * as cliArgs from "command-line-args";
import * as usage from "command-line-usage";
import { v4 as uuid } from "uuid";
import { IMatrixEvent } from "./matrixtypes";
import { MetricPeg, PrometheusBridgeMetrics } from "./metrics";
import { Response } from "express";

const log = new Log("DiscordAS");

const commandOptions = [
    { name: "config", alias: "c", type: String },
    { name: "url", alias: "u", type: String },
    { name: "port", alias: "p", type: Number },
    { name: "file", alias: "f", type: String },
    { name: "generate-registration", alias: "r", type: Boolean },
    { name: "help", alias: "h", type: Boolean },
];

function generateRegistration(opts, registrationPath: string): void {
    if (!opts.url) {
        throw Error("'url' not given in command line opts, cannot generate registration file");
    }
    const reg = {
        /* eslint-disable @typescript-eslint/camelcase */
        as_token: uuid(),
        hs_token: uuid(),
        id: "discord-bridge",
        namespaces: {
            aliases: [
                {
                    exclusive: true,
                    regex: "#_discord_.*",
                },
            ],
            rooms: [ ],
            users: [
                {
                    exclusive: true,
                    regex: "@_discord_.*",
                },
            ],
        },
        protocols: ["discord"],
        rate_limited: false,
        sender_localpart: "_discord_bot",
        url: opts.url,
        /* eslint-enable @typescript-eslint/camelcase */
    } as IAppserviceRegistration;
    fs.writeFileSync(registrationPath, yaml.safeDump(reg));
}

function setupLogging(): void {
    const logMap = new Map<string, Log>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const logFunc = (level: string, module: string, args: any[]): void => {
        if (!Array.isArray(args)) {
            args = [args];
        }
        if (args.find((s) => s.includes && s.includes("M_USER_IN_USE"))) {
            // Spammy logs begon
            return;
        }
        const mod = `bot-sdk${module}`;
        let logger = logMap.get(mod);
        if (!logger) {
            logger = new Log(mod);
            logMap.set(mod, logger);
        }
        logger[level](args);
    };

    LogService.setLogger({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        debug: (mod: string, args: any[]) => logFunc("silly", mod, args),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        error: (mod: string, args: any[]) => logFunc("error", mod, args),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        info: (mod: string, args: any[]) => logFunc("info", mod, args),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        warn: (mod: string, args: any[]) => logFunc("warn", mod, args),
    });
}

async function run(): Promise<void> {
    const opts = cliArgs(commandOptions);
    if (opts.help) {
        // eslint-disable-next-line no-console
        console.log(usage([
            {
                content: "The matrix appservice for discord",
                header: "Matrix Discord Bridge",
            },
            {
                header: "Options",
                optionList: commandOptions,
            },
        ]));
        process.exit(0);
    }

    const configPath = opts.config || "config.yaml";
    const registrationPath = opts.file || "discord-registration.yaml";
    if (opts["generate-registration"]) {
        if (fs.existsSync(registrationPath)) {
            throw Error("Not writing new registration file, file already exists");
        }
        generateRegistration(opts, registrationPath);
        return;
    }

    const config = new DiscordBridgeConfig();
    const readConfig = yaml.safeLoad(fs.readFileSync(configPath, "utf8"));
    if (typeof readConfig !== "object") {
        throw Error("Config is not of type object");
    }
    config.applyConfig(readConfig);
    config.applyEnvironmentOverrides(process.env);
    Log.Configure(config.logging);
    const port = opts.port || config.bridge.port;
    if (!port) {
        throw Error("Port not given in command line or config file");
    }
    if (config.database.roomStorePath || config.database.userStorePath) {
        log.error("The keys 'roomStorePath' and/or 'userStorePath' is still defined in the config. " +
                  "Please see docs/bridge-migrations.md on " +
                  "https://github.com/Half-Shot/matrix-appservice-discord/");
        throw Error("Bridge has legacy configuration options and is unable to start");
    }
    const registration = yaml.safeLoad(fs.readFileSync(registrationPath, "utf8")) as IAppserviceRegistration;
    setupLogging();

    const store = new DiscordStore(config.database);

    const appservice = new Appservice({
        bindAddress: config.bridge.bindAddress || "0.0.0.0",
        homeserverName: config.bridge.domain,
        homeserverUrl: config.bridge.homeserverUrl,
        port,
        registration,
        storage: store,
    });

    if (config.metrics.enable) {
        log.info("Enabled metrics");
        MetricPeg.set(new PrometheusBridgeMetrics().init(appservice, config.metrics));
    }

    try {
        await store.init();
    } catch (ex) {
        log.error("Failed to init database. Exiting.", ex);
        process.exit(1);
    }

    const discordbot = new DiscordBot(config, appservice, store);
    const roomhandler = discordbot.RoomHandler;
    const eventProcessor = discordbot.MxEventProcessor;

    // 2020-12-07: If this fails to build in TypeScript with
    // "Namespace 'serveStatic' has no exported member 'RequestHandlerConstructor'.",
    // remove @types/express-serve-static-core and @types/serve-static from yarn.lock
    // and run yarn.
    // See https://github.com/DefinitelyTyped/DefinitelyTyped/issues/49595
    appservice.expressAppInstance.get("/health", (_, res: Response) => {
        res.status(200).send("");
    });

    appservice.on("query.room", async (roomAlias: string, createRoom: (opts: unknown) => Promise<void>) => {
        try {
            const createRoomOpts = await roomhandler.OnAliasQuery(roomAlias);
            if (!createRoomOpts) {
                // This will tell the homeserver that the alias request failed.
                await createRoom(false);
                return;
            }
            await createRoom(createRoomOpts);
            await roomhandler.OnAliasQueried(roomAlias, createRoomOpts.__roomId);
        } catch (err) {
            log.error("Exception thrown while handling \"query.room\" event", err);
        }
    });

    appservice.on("room.event", async (roomId: string, event: IMatrixEvent) => {
        try {
            const entries = await store.roomStore.getEntriesByMatrixId(roomId);
            await eventProcessor.OnEvent(event, entries);
        } catch (err) {
            log.error("Exception thrown while handling \"room.event\" event", err);
        }
    });

    roomhandler.bindThirdparty();

    await appservice.begin();
    log.info(`Started listening on port ${port}`);

    try {
        await discordbot.init();
        await discordbot.run();
        log.info("Discordbot started successfully");
    } catch (err) {
        log.error(err);
        log.error("Failure during startup. Exiting");
        process.exit(1);
    }
}

run().catch((err) => {
    log.error("A fatal error occurred during startup:", err);
    process.exit(1);
});
