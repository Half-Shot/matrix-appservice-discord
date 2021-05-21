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

import { expect } from "chai";
import { DiscordBridgeConfig } from "../src/config";

describe("DiscordBridgeConfig.applyConfig", () => {
    it("should merge configs correctly", () => {
        const config = new DiscordBridgeConfig();
        config.applyConfig({
            bridge: {
                disableDeletionForwarding: true,
                disableDiscordMentions: false,
                disableInviteNotifications: true,
                disableJoinLeaveNotifications: true,
                disableTypingNotifications: true,
                enableSelfServiceBridging: false,
                homeserverUrl: "blah",
            },
            logging: {
                console: "warn",
            },
        });
        expect(config.bridge.homeserverUrl).to.equal("blah");
        expect(config.bridge.disableTypingNotifications).to.be.true;
        expect(config.bridge.disableDiscordMentions).to.be.false;
        expect(config.bridge.disableDeletionForwarding).to.be.true;
        expect(config.bridge.enableSelfServiceBridging).to.be.false;
        expect(config.bridge.disableJoinLeaveNotifications).to.be.true;
        expect(config.bridge.disableInviteNotifications).to.be.true;
        expect(config.logging.console).to.equal("warn");
    });
    it("should merge environment overrides correctly", () => {
        const config = new DiscordBridgeConfig();
        config.applyConfig({
            bridge: {
                disableDeletionForwarding: true,
                disableDiscordMentions: false,
                homeserverUrl: "blah",
            },
            logging: {
                console: "warn",
            },
        });
        config.applyEnvironmentOverrides({
            APPSERVICE_DISCORD_BRIDGE_DISABLE_DELETION_FORWARDING: false,
            APPSERVICE_DISCORD_BRIDGE_DISABLE_INVITE_NOTIFICATIONS: true,
            APPSERVICE_DISCORD_BRIDGE_DISABLE_JOIN_LEAVE_NOTIFICATIONS: true,
            APPSERVICE_DISCORD_LOGGING_CONSOLE: "debug",
        });
        expect(config.bridge.disableJoinLeaveNotifications).to.be.true;
        expect(config.bridge.disableInviteNotifications).to.be.true;
        expect(config.bridge.disableDeletionForwarding).to.be.false;
        expect(config.bridge.disableDiscordMentions).to.be.false;
        expect(config.bridge.homeserverUrl).to.equal("blah");
        expect(config.logging.console).to.equal("debug");
    });
    it("should merge logging.files correctly", () => {
        const config = new DiscordBridgeConfig();
        config.applyConfig({
            logging: {
                console: "silent",
                files: [
                    {
                        file: "./bacon.log",
                    },
                ],
            },
        });
        expect(config.logging.files[0].file).to.equal("./bacon.log");
    });
});
