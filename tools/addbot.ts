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

/* eslint-disable no-bitwise, no-console */
/**
 * Generates a URL you can use to authorize a bot with a guild.
 */
import * as yaml from "js-yaml";
import * as fs from "fs";
import * as args from "command-line-args";
import * as usage from "command-line-usage";
import { Util } from "../src/util";
import { DiscordBridgeConfig } from "../src/config";

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
];

const options = args(optionDefinitions);

if (options.help) {
    console.log(usage([
        {
            content: "A tool to obtain the Discord bot invitation URL.",
            header: "Add bot",
        },
        {
            header: "Options",
            optionList: optionDefinitions,
        },
    ]));
    process.exit(0);
}

const yamlConfig = yaml.safeLoad(fs.readFileSync(options.config, "utf8"));
if (yamlConfig === null || typeof yamlConfig !== "object") {
    throw Error("You have an error in your discord config.");
}
const url = Util.GetBotLink(yamlConfig as DiscordBridgeConfig);
console.log(`Go to ${url} to invite the bot into a guild.`);
