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
import { DiscordBot } from "../src/bot";
import { Log } from "../src/log";
import { Util } from "../src/util";
import { ToolsHelper } from "./toolshelper";

const log = new Log("ChanFix");

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
            content: "A tool to fix channels of rooms already bridged " +
        "to matrix, to make sure their names, icons etc. are correctly.",
            header: "Fix bridged channels",
        },
        {
            header: "Options",
            optionList: optionDefinitions,
        },
    ]));
    process.exit(0);
}

async function run() {
    const {store, appservice, config} = ToolsHelper.getToolDependencies(options.config, options.registration);
    await store!.init();
    const discordbot = new DiscordBot(config, appservice, store!);
    await discordbot.init();
    await discordbot.ClientFactory.init();
    const client = await discordbot.ClientFactory.getClient();

    // first set update_icon to true if needed
    const mxRoomEntries = await store!.roomStore.getEntriesByRemoteRoomData({
        update_name: true,
        update_topic: true,
    });

    const promiseList: Promise<void>[] = [];
    mxRoomEntries.forEach((entry) => {
        if (entry.remote!.get("plumbed")) {
            return; // skipping plumbed rooms
        }
        const updateIcon = entry.remote!.get("update_icon");
        if (updateIcon !== undefined && updateIcon !== null) {
            return; // skipping because something was set manually
        }
        entry.remote!.set("update_icon", true);
        promiseList.push(store!.roomStore.upsertEntry(entry));
    });
    await Promise.all(promiseList);

    // now it is time to actually run the updates
    const promiseList2: Promise<void>[] = [];

    let curDelay = config.limits.roomGhostJoinDelay; // we'll just re-use this
    client.guilds.cache.forEach((guild) => {
        promiseList2.push((async () => {
            await Util.DelayedPromise(curDelay);
            try {
                await discordbot.ChannelSyncroniser.OnGuildUpdate(guild, true);
            } catch (err) {
                log.warn(`Couldn't update rooms of guild ${guild.id}`, err);
            }
        })());
        curDelay += config.limits.roomGhostJoinDelay;
    });
    try {
        await Promise.all(promiseList2);
    } catch (err) {
        log.error(err);
    }
    process.exit(0);
}

void run();
