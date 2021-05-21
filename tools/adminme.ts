/*
Copyright 2017, 2018 matrix-appservice-discord

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
 * Allows you to become an admin for a room that the bot is in control of.
 */

import * as args from "command-line-args";
import * as usage from "command-line-usage";
import { ToolsHelper } from "./toolshelper";

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
    {
        alias: "m",
        description: "The roomid to modify",
        name: "roomid",
        type: String,
    },
    {
        alias: "u",
        description: "The userid to give powers",
        name: "userid",
        type: String,
    },
    {
        alias: "p",
        defaultValue: 100,
        description: "The power to set",
        name: "power",
        type: Number,
        typeLabel: "<0-100>",
    },
];

const options = args(optionDefinitions);

if (options.help) {
    console.log(usage([
        {
            content: "A tool to give a user a power level in a bot user controlled room.",
            header: "Admin Me",
        },
        {
            header: "Options",
            optionList: optionDefinitions,
        },
    ]));
    process.exit(0);
}

if (!options.roomid) {
    console.error("Missing roomid parameter. Check -h");
    process.exit(1);
}

if (!options.userid) {
    console.error("Missing userid parameter. Check -h");
    process.exit(1);
}

const {appservice} = ToolsHelper.getToolDependencies(options.config, options.registration, false);

async function run() {
    try {
        const powerLevels = (await appservice.botIntent.underlyingClient.getRoomStateEvent(
            options.roomid, "m.room.power_levels", "",
        ));
        powerLevels.users[options.userid] = options.power;

        await appservice.botIntent.underlyingClient.sendStateEvent(
            options.roomid, "m.room.power_levels", "", powerLevels,
        );
        console.log("Power levels set");
        process.exit(0);
    } catch (err) {
        console.error("Could not apply power levels to room:", err);
        process.exit(1);
    }
}

void run();
