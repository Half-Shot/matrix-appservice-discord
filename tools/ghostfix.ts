/*
Copyright 2018 matrix-appservice-discord

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

import * as args from "command-line-args";
import * as usage from "command-line-usage";
import { Log } from "../src/log";
import { Util } from "../src/util";
import { DiscordBot } from "../src/bot";
import { ToolsHelper } from "./toolshelper";

const log = new Log("GhostFix");

// Note: The schedule must not have duplicate values to avoid problems in positioning.
const JOIN_ROOM_SCHEDULE = [
    0,              // Right away
    1000,           // 1 second
    30000,          // 30 seconds
    300000,         // 5 minutes
    900000,         // 15 minutes
];

const optionDefinitions = [
    {
        alias: "h",
        description: "Display this usage guide.",
        name: "help",
        type: Boolean,
    },
    {
        alias: "c",
        defaultValue: "config.yaml",
        description: "The AS config file.",
        name: "config",
        type: String,
        typeLabel: "<config.yaml>",
    },
    {
        alias: "r",
        defaultValue: "discord-registration.yaml",
        description: "The AS registration file.",
        name: "registration",
        type: String,
        typeLabel: "<discord-registration.yaml>",
    },
];

const options = args(optionDefinitions);

if (options.help) {
    console.log(usage([
        {
            content: "A tool to fix usernames of ghosts already in " +
            "matrix rooms, to make sure they represent the correct discord usernames.",
            header: "Fix usernames of joined ghosts",
        },
        {
            header: "Options",
            optionList: optionDefinitions,
        },
    ]));
    process.exit(0);
}

async function run() {
    const {appservice, config, store} = ToolsHelper.getToolDependencies(options.config, options.registration);
    await store!.init();
    const discordbot = new DiscordBot(config, appservice, store!);
    await discordbot.init();
    const client = await discordbot.ClientFactory.getClient();

    const promiseList: Promise<void>[] = [];
    let curDelay = config.limits.roomGhostJoinDelay;
    try {
        client.guilds.cache.forEach((guild) => {
            guild.members.cache.forEach((member) => {
                if (member.id === client.user?.id) {
                    return;
                }
                promiseList.push((async () => {
                    await Util.DelayedPromise(curDelay);
                    let currentSchedule = JOIN_ROOM_SCHEDULE[0];
                    const doJoin = async () => {
                        await Util.DelayedPromise(currentSchedule);
                        await discordbot.UserSyncroniser.OnUpdateGuildMember(member, true, false);
                    };
                    const errorHandler = async (err) => {
                        log.error(`Error joining rooms for ${member.id}`);
                        log.error(err);
                        const idx = JOIN_ROOM_SCHEDULE.indexOf(currentSchedule);
                        if (idx === JOIN_ROOM_SCHEDULE.length - 1) {
                            log.warn(`Cannot join rooms for ${member.id}`);
                            throw new Error(err);
                        } else {
                            currentSchedule = JOIN_ROOM_SCHEDULE[idx + 1];
                            try {
                                await doJoin();
                            } catch (e) {
                                await errorHandler(e);
                            }
                        }
                    };
                    try {
                        await doJoin();
                    } catch (e) {
                        await errorHandler(e);
                    }
                })());
                curDelay += config.limits.roomGhostJoinDelay;
            });
        });

        await Promise.all(promiseList);
    } catch (err) {
        log.error(err);
    }
    process.exit(0);
}

void run();
