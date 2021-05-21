/*
Copyright 2019 matrix-appservice-discord

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
import * as Proxyquire from "proxyquire";

import { MockChannel } from "./mocks/channel";
import { MockMember } from "./mocks/member";
import { MockGuild } from "./mocks/guild";
import { Util } from "../src/util";
import { AppserviceMock } from "./mocks/appservicemock";

let ROOMSUNBRIDGED = 0;
let MARKED = -1;
function createCH(opts: any = {}) {
    ROOMSUNBRIDGED = 0;
    MARKED = -1;
    const bridge = new AppserviceMock();
    const cs = {
        GetRoomIdsFromChannel: async (chan) => {
            return [`#${chan.id}:localhost`];
        },
    };
    const discord = {
        ChannelSyncroniser: cs,
        Provisioner: {
            HasPendingRequest: (chan): boolean => true,
            MarkApproved: async (chan, member, approved) => {
                MARKED = approved ? 1 : 0;
                return approved;
            },
            UnbridgeChannel: (): void => {
                ROOMSUNBRIDGED++;
            },
        },
    };
    const discordCommandHndlr = (Proxyquire("../src/discordcommandhandler", {
        "./util": {
            Util: {
                GetMxidFromName: (): string => {
                    return "@123456:localhost";
                },
                ParseCommand: Util.ParseCommand,
            },
        },
    })).DiscordCommandHandler;
    return {handler: new discordCommandHndlr(bridge as any, discord as any), bridge};
}

describe("DiscordCommandHandler", () => {
    it("will kick a member", async () => {
        const {handler, bridge} = createCH();
        const channel = new MockChannel("123");
        const guild = new MockGuild("456", [channel]);
        channel.guild = guild;
        const member: any = new MockMember("123456", "blah");
        member.hasPermission = (): boolean => {
            return true;
        };
        const message = {
            channel,
            content: "!matrix kick someuser",
            member,
        };
        await handler.Process(message);
        bridge.botIntent.underlyingClient.wasCalled("kickUser", true, "#123:localhost", "@123456:localhost");
    });
    it("will kick a member in all guild rooms", async () => {
        const {handler, bridge} = createCH();
        const channel = new MockChannel("123");
        const guild = new MockGuild("456", [channel, (new MockChannel("456"))]);
        channel.guild = guild;
        const member: any = new MockMember("123456", "blah");
        member.hasPermission = (): boolean => {
            return true;
        };
        const message = {
            channel,
            content: "!matrix kick someuser",
            member,
        };
        await handler.Process(message);
        expect(bridge.botIntent.underlyingClient.wasCalled("kickUser")).to.equal(2);
    });
    it("will deny permission", async () => {
        const {handler, bridge} = createCH();
        const channel = new MockChannel("123");
        const guild = new MockGuild("456", [channel]);
        channel.guild = guild;
        const member: any = new MockMember("123456", "blah");
        member.hasPermission = (): boolean => {
            return false;
        };
        const message = {
            channel,
            content: "!matrix kick someuser",
            member,
        };
        await handler.Process(message);
        expect(bridge.botIntent.underlyingClient.wasCalled("kickUser", false)).to.equal(0);
    });
    it("will ban a member", async () => {
        const {handler, bridge} = createCH();
        const channel = new MockChannel("123");
        const guild = new MockGuild("456", [channel]);
        channel.guild = guild;
        const member: any = new MockMember("123456", "blah");
        member.hasPermission = (): boolean => {
            return true;
        };
        const message = {
            channel,
            content: "!matrix ban someuser",
            member,
        };
        await handler.Process(message);
        expect(bridge.botIntent.underlyingClient.wasCalled("banUser")).to.equal(1);
    });
    it("will unban a member", async () => {
        const {handler, bridge} = createCH();
        const channel = new MockChannel("123");
        const guild = new MockGuild("456", [channel]);
        channel.guild = guild;
        const member: any = new MockMember("123456", "blah");
        member.hasPermission = (): boolean => {
            return true;
        };
        const message = {
            channel,
            content: "!matrix unban someuser",
            member,
        };
        await handler.Process(message);
        expect(bridge.botIntent.underlyingClient.wasCalled("unbanUser")).to.equal(1);
    });
    it("handles !matrix approve", async () => {
        const {handler} = createCH();
        const channel = new MockChannel("123");
        const guild = new MockGuild("456", [channel]);
        channel.guild = guild;
        const member: any = new MockMember("123456", "blah");
        member.hasPermission = (): boolean => {
            return true;
        };
        const message = {
            channel,
            content: "!matrix approve",
            member,
        };
        await handler.Process(message);
        expect(MARKED).equals(1);
    });
    it("handles !matrix deny", async () => {
        const {handler} = createCH();
        const channel = new MockChannel("123");
        const guild = new MockGuild("456", [channel]);
        channel.guild = guild;
        const member: any = new MockMember("123456", "blah");
        member.hasPermission = (): boolean => {
            return true;
        };
        const message = {
            channel,
            content: "!matrix deny",
            member,
        };
        await handler.Process(message);
        expect(MARKED).equals(0);
    });
    it("handles !matrix unbridge", async () => {
        const {handler} = createCH();
        const channel = new MockChannel("123");
        const guild = new MockGuild("456", [channel]);
        channel.guild = guild;
        const member: any = new MockMember("123456", "blah");
        member.hasPermission = (): boolean => {
            return true;
        };
        const message = {
            channel,
            content: "!matrix unbridge",
            member,
        };
        await handler.Process(message);
        expect(ROOMSUNBRIDGED).equals(1);
    });
});
