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

/**
 * Allows you to become an admin for a room the bot is in control of.
 */

import * as args from "command-line-args";
import * as usage from "command-line-usage";
import { Log } from "../src/log";
import { Util } from "../src/util";
import { ToolsHelper } from "./toolshelper";
const log = new Log("AddRoomsToDirectory");
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
            content: "A tool to set all the bridged rooms to visible in the directory.",
            header: "Add rooms to directory",
        },
        {
            header: "Options",
            optionList: optionDefinitions,
        },
    ]));
    process.exit(0);
}

const {store, appservice} = ToolsHelper.getToolDependencies(options.config, options.registration, true);

async function run(): Promise<void> {
    try {
        await store!.init();
    } catch (e) {
        log.error(`Failed to load database`, e);
    }
    let rooms = await store!.roomStore.getEntriesByRemoteRoomData({
        discord_type: "text",
    });
    rooms = rooms.filter((r) => r.remote && r.remote.get("plumbed") !== true );
    log.info(`Got ${rooms.length} rooms to set`);
    try {
        await Util.AsyncForEach(rooms, async (room) => {
            const guild = room.remote!.get("discord_guild");
            const roomId = room.matrix!.getId();
            try {
                await appservice.botIntent.underlyingClient.setDirectoryVisibility(
                    roomId,
                    "public",
                );
                log.info(`Set ${roomId} to visible in ${guild}'s directory`);
            } catch (e) {
                log.error(`Failed to set ${roomId} to visible in ${guild}'s directory`, e);
            }
        });
    } catch (e) {
        log.error(`Failed to run script`, e);
    }
}

void run();
