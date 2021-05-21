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
import {IGuildMemberState, IUserState, UserSyncroniser} from "../src/usersyncroniser";
import {MockUser} from "./mocks/user";
import {DiscordBridgeConfig} from "../src/config";
import * as Proxyquire from "proxyquire";
import {MockMember} from "./mocks/member";
import {MockGuild} from "./mocks/guild";
import { MockChannel } from "./mocks/channel";
import { MockRole } from "./mocks/role";
import { Util } from "../src/util";
import { RemoteUser } from "../src/db/userstore";
import { AppserviceMock } from "./mocks/appservicemock";

let LINK_MX_USER: any = null;
let LINK_RM_USER: any = null;
let UTIL_UPLOADED_AVATAR: any = false;
let REMOTEUSER_SET: any = null;

const GUILD_ROOM_IDS = ["!abc:localhost", "!def:localhost", "!ghi:localhost"];
const GUILD_ROOM_IDS_WITH_ROLE = ["!abc:localhost", "!def:localhost"];

const UserSync = (Proxyquire("../src/usersyncroniser", {
    "./util": {
        Util: {
            ApplyPatternString: Util.ApplyPatternString,
            AsyncForEach: Util.AsyncForEach,
            DownloadFile: async () => {
                UTIL_UPLOADED_AVATAR = true;
                return {buffer: Buffer.from([])};
            },
            ParseMxid: Util.ParseMxid,
        },
    },
})).UserSyncroniser;

function CreateUserSync(remoteUsers: RemoteUser[] = [], ghostConfig: any = {}) {
    UTIL_UPLOADED_AVATAR = false;
    const bridge = new AppserviceMock();
    const discordbot: any = {
        GetChannelFromRoomId: (id) => {
            if (id === "!found:localhost") {
                const guild = new MockGuild("666666");
                guild.members.cache.set("123456", new MockMember("123456", "fella", guild));
                const chan = new MockChannel("543345", guild);
                guild.channels.cache.set("543345", chan as any);
                return chan;
            }
            throw new Error("Channel not found");
        },
        GetGuilds: () => {
            return [];
        },
        GetIntentFromDiscordMember: (member) => {
            return bridge.getIntentForSuffix(member.id);
        },
        GetRoomIdsFromGuild: async (guild: MockGuild, member: MockMember) => {
            if (member && member.roles.cache.get("1234")) {
                return GUILD_ROOM_IDS_WITH_ROLE;
            }
            return GUILD_ROOM_IDS;
        },
    };
    REMOTEUSER_SET = null;
    LINK_RM_USER = null;
    LINK_MX_USER = null;
    const userStore = {
        getRemoteUser: (id) => remoteUsers.find((u) => u.id === id) || null,
        getRemoteUsersFromMatrixId: (id) => remoteUsers.filter((u) => u.id === id),
        linkUsers: (mxUser, remoteUser) => {
            LINK_MX_USER = mxUser;
            LINK_RM_USER = remoteUser;
        },
        setRemoteUser: async (remoteUser) => {
            REMOTEUSER_SET = remoteUser;
        },
    };
    const config = new DiscordBridgeConfig();
    config.bridge.domain = "localhost";
    config.ghosts = Object.assign({}, config.ghosts, ghostConfig);
    const userSync: UserSyncroniser = new UserSync(bridge as any, config, discordbot, userStore as any);
    return {bridge, userSync};
}

describe("UserSyncroniser", () => {
    describe("GetUserUpdateState", () => {
        it("Will create a new user", async () => {
            const {userSync} = CreateUserSync();
            const user = new MockUser(
                "123456",
                "TestUsername",
                "6969",
                "test.jpg",
                "111",
            );
            const state = await userSync.GetUserUpdateState(user as any);
            expect(state.createUser).is.true;
            expect(state.removeAvatar).is.false;
            expect(state.displayName).equals("TestUsername#6969");
            expect(state.mxUserId).equals("@_discord_123456:localhost");
            expect(state.avatarId).equals("111");
            expect(state.avatarUrl).equals("test.jpg");
        });
        it("Will change display names", async () => {
            const remoteUser = new RemoteUser("123456");
            remoteUser.avatarurl = "test.jpg";
            remoteUser.displayname = "TestUsername";

            const {userSync} = CreateUserSync([remoteUser]);
            const user = new MockUser(
                "123456",
                "TestUsername",
                "6969",
                "test.jpg",
                "111",
            );
            const state = await userSync.GetUserUpdateState(user as any);
            expect(state.createUser, "CreateUser").is.false;
            expect(state.removeAvatar, "RemoveAvatar").is.false;
            expect(state.displayName, "DisplayName").equals("TestUsername#6969");
            expect(state.mxUserId , "UserId").equals("@_discord_123456:localhost");
            expect(state.avatarId, "AvatarID").is.empty;
            expect(state.avatarUrl, "AvatarUrl").is.null;
        });
        it("Will obay name patterns", async () => {
            const remoteUser = new RemoteUser("123456");
            remoteUser.avatarurl = "test.jpg";
            remoteUser.displayname = "TestUsername";

            const {userSync} = CreateUserSync([remoteUser], {usernamePattern: ":username#:tag (Discord)"});
            const user = new MockUser(
                "123456",
                "TestUsername",
                "6969",
                "test.jpg",
                "111",
            );
            const state = await userSync.GetUserUpdateState(user as any);
            expect(state.createUser, "CreateUser").is.false;
            expect(state.removeAvatar, "RemoveAvatar").is.false;
            expect(state.displayName, "DisplayName").equals("TestUsername#6969 (Discord)");
            expect(state.mxUserId , "UserId").equals("@_discord_123456:localhost");
            expect(state.avatarId, "AvatarID").is.empty;
            expect(state.avatarUrl, "AvatarUrl").is.null;
        });
        it("Will change avatars", async () => {
            const remoteUser = new RemoteUser("123456");
            remoteUser.avatarurl = "test.jpg";
            remoteUser.displayname = "TestUsername#6969";

            const {userSync} = CreateUserSync([remoteUser]);
            const user = new MockUser(
                "123456",
                "TestUsername",
                "6969",
                "test2.jpg",
                "111",
            );
            const state = await userSync.GetUserUpdateState(user as any);
            expect(state.createUser, "CreateUser").is.false;
            expect(state.removeAvatar, "RemoveAvatar").is.false;
            expect(state.avatarUrl, "AvatarUrl").equals("test2.jpg");
            expect(state.mxUserId , "UserId").equals("@_discord_123456:localhost");
            expect(state.avatarId, "AvatarID").is.equals("111");
            expect(state.displayName, "DisplayName").is.null;
        });
        it("Will remove avatars", async () => {
            const remoteUser = new RemoteUser("123456");
            remoteUser.avatarurl = "test.jpg";
            remoteUser.displayname = "TestUsername#6969";

            const {userSync} = CreateUserSync([remoteUser]);
            const user = new MockUser(
                "123456",
                "TestUsername",
                "6969",
                null,
                null,
            );
            const state = await userSync.GetUserUpdateState(user as any);
            expect(state.createUser, "CreateUser").is.false;
            expect(state.removeAvatar, "RemoveAvatar").is.true;
            expect(state.avatarUrl, "AvatarUrl").is.null;
            expect(state.mxUserId , "UserId").equals("@_discord_123456:localhost");
            expect(state.avatarId, "AvatarID").is.empty;
            expect(state.displayName, "DisplayName").is.null;
        });
    });
    describe("ApplyStateToProfile", () => {
        it("Will create a new user", async () => {
            const {userSync} = CreateUserSync();
            const state: IUserState = {
                avatarId: "",
                avatarUrl: null, // Nullable
                createUser: true,
                displayName: null, // Nullable
                id: "123456",
                mxUserId: "@_discord_123456:localhost",
                removeAvatar: false,
            };
            await userSync.ApplyStateToProfile(state);
            expect(LINK_MX_USER).is.not.null;
            expect(LINK_RM_USER).is.not.null;
            expect(REMOTEUSER_SET).is.null;
        });
        it("Will set a display name", async () => {
            const {userSync, bridge} = CreateUserSync();
            const state: IUserState = {
                avatarId: "",
                avatarUrl: null, // Nullable
                createUser: true,
                displayName: "123456", // Nullable
                id: "123456",
                mxUserId: "@_discord_123456:localhost",
                removeAvatar: false,
            };
            await userSync.ApplyStateToProfile(state);
            expect(LINK_MX_USER).is.not.null;
            expect(LINK_RM_USER).is.not.null;
            expect(REMOTEUSER_SET).is.not.null;
            expect(REMOTEUSER_SET.displayname).equal("123456");
            expect(REMOTEUSER_SET.avatarurl).is.null;
            bridge.getIntentForUserId("@_discord_123456:localhost")
                .underlyingClient.wasCalled("setDisplayName", true, "123456");
            bridge.getIntentForUserId("@_discord_123456:localhost")
                .underlyingClient.wasNotCalled("setAvatarUrl", true);
        });
        it("Will set an avatar", async () => {
            const {userSync, bridge} = CreateUserSync();
            const state: IUserState = {
                avatarId: "avatarurl",
                avatarUrl: "654321", // Nullable
                createUser: true,
                displayName: null, // Nullable
                id: "123456",
                mxUserId: "@_discord_123456:localhost",
                removeAvatar: false,
            };
            await userSync.ApplyStateToProfile(state);
            expect(LINK_MX_USER).is.not.null;
            expect(LINK_RM_USER).is.not.null;
            expect(UTIL_UPLOADED_AVATAR).to.be.true;
            expect(REMOTEUSER_SET).is.not.null;
            expect(REMOTEUSER_SET.avatarurl).equal("654321");
            expect(REMOTEUSER_SET.displayname).is.null;
            bridge.getIntentForUserId("@_discord_123456:localhost")
                .underlyingClient.wasCalled("setAvatarUrl", true, "mxc://avatarurl");
            bridge.getIntentForUserId("@_discord_123456:localhost")
                .underlyingClient.wasNotCalled("setDisplayName", true);
        });
        it("Will remove an avatar", async () => {
            const {userSync, bridge} = CreateUserSync();
            const state: IUserState = {
                avatarId: "",
                avatarUrl: null, // Nullable
                createUser: true,
                displayName: null, // Nullable
                id: "123456",
                mxUserId: "@_discord_123456:localhost",
                removeAvatar: true,
            };
            await userSync.ApplyStateToProfile(state);
            expect(LINK_MX_USER).is.not.null;
            expect(LINK_RM_USER).is.not.null;
            expect(UTIL_UPLOADED_AVATAR).to.be.false;
            expect(REMOTEUSER_SET).is.not.null;
            expect(REMOTEUSER_SET.avatarurl).is.null;
            expect(REMOTEUSER_SET.displayname).is.null;
            bridge.getIntentForUserId("@_discord_123456:localhost")
                .underlyingClient.wasNotCalled("setAvatarUrl", true);
            bridge.getIntentForUserId("@_discord_123456:localhost")
                .underlyingClient.wasNotCalled("setDisplayName", true);
        });
        it("will do nothing if nothing needs to be done", async () => {
            const {userSync, bridge} = CreateUserSync([new RemoteUser("123456")]);
            const state: IUserState = {
                avatarId: "",
                avatarUrl: null, // Nullable
                createUser: false,
                displayName: null, // Nullable
                id: "123456",
                mxUserId: "@_discord_123456:localhost",
                removeAvatar: false,
            };
            await userSync.ApplyStateToProfile(state);
            expect(LINK_MX_USER).is.null;
            expect(LINK_RM_USER).is.null;
            expect(REMOTEUSER_SET).is.null;
            bridge.getIntentForUserId("@_discord_123456:localhost")
                .underlyingClient.wasNotCalled("setAvatarUrl", true);
            bridge.getIntentForUserId("@_discord_123456:localhost")
                .underlyingClient.wasNotCalled("setDisplayName", true);
        });
    });
    describe("ApplyStateToRoom", () => {
        it("Will apply a new nick", async () => {
            const {userSync, bridge} = CreateUserSync([new RemoteUser("123456")]);
            const state: IGuildMemberState = {
                bot: false,
                displayColor: 0,
                displayName: "Good Boy",
                id: "123456",
                mxUserId: "@_discord_123456:localhost",
                roles: [],
                username: "",
            };
            await userSync.ApplyStateToRoom(state, "!abc:localhost", "123456");
            expect(REMOTEUSER_SET).is.not.null;
            expect(REMOTEUSER_SET.guildNicks.get("123456")).is.equal("Good Boy");
            bridge.getIntentForUserId("@_discord_123456:localhost").underlyingClient.wasCalled(
                "sendStateEvent", true, "!abc:localhost",
                "m.room.member", "@_discord_123456:localhost", {
                    "avatar_url": "",
                    "displayname": "Good Boy",
                    "membership": "join",
                    "uk.half-shot.discord.member": {
                        bot: false,
                        displayColor: 0,
                        id: "123456",
                        roles: [],
                        username: "",
                    },
                },
            );
        });
        it("Will not apply unchanged nick", async () => {
            const {userSync, bridge} = CreateUserSync([new RemoteUser("123456")]);
            const state: IGuildMemberState = {
                bot: false,
                displayColor: 0,
                displayName: "",
                id: "123456",
                mxUserId: "@_discord_123456:localhost",
                roles: [],
                username: "",
            };
            await userSync.ApplyStateToRoom(state, "!abc:localhost", "123456");
            expect(REMOTEUSER_SET).is.null;
            bridge.getIntentForUserId("@_discord_123456:localhost")
                .underlyingClient.wasNotCalled("sendStateEvent", true);
        });
        it("Will apply roles", async () => {
            const {userSync, bridge} = CreateUserSync([new RemoteUser("123456")]);
            const TESTROLE_NAME = "testrole";
            const TESTROLE_COLOR = 1337;
            const TESTROLE_POSITION = 42;
            const state: IGuildMemberState = {
                bot: false,
                displayColor: 0,
                displayName: "Good Boy",
                id: "123456",
                mxUserId: "@_discord_123456:localhost",
                roles: [
                    {
                        color: TESTROLE_COLOR,
                        name: TESTROLE_NAME,
                        position: TESTROLE_POSITION,
                    },
                ],
                username: "",
            };
            await userSync.ApplyStateToRoom(state, "!abc:localhost", "12345678");
            bridge.getIntentForUserId("@_discord_123456:localhost").underlyingClient.sendStateEvent(
                "!abc:localhost",
                "m.room.member",
                "@_discord_123456:localhost", {
                    "displayColor": 0,
                    "displayname": state.displayName,
                    "uk.half-shot.discord.member": {
                        id: "123456",
                        roles: state.roles,
                    },
                },
            );
        });
        it("Will set bot correctly", async () => {
            const {userSync, bridge} = CreateUserSync([new RemoteUser("123456")]);
            const state: IGuildMemberState = {
                bot: false,
                displayColor: 0,
                displayName: "Good Boy",
                id: "123456",
                mxUserId: "@_discord_123456:localhost",
                roles: [ ],
                username: "",
            };
            await userSync.ApplyStateToRoom(state, "!abc:localhost", "12345678");
            bridge.getIntentForUserId("@_discord_123456:localhost").underlyingClient.sendStateEvent(
                "!abc:localhost",
                "m.room.member",
                "@_discord_123456:localhost", {
                    "bot": false,
                    "displayColor": 0,
                    "displayname": state.displayName,
                    "uk.half-shot.discord.member": {
                        id: "123456",
                        roles: state.roles,
                    },
                },
            );

            const sync2 = CreateUserSync([new RemoteUser("123456")]);
            state.bot = true;
            await sync2.userSync.ApplyStateToRoom(state, "!abc:localhost", "12345678");
            sync2.bridge.getIntentForUserId("@_discord_123456:localhost").underlyingClient.sendStateEvent(
                "!abc:localhost",
                "m.room.member",
                "@_discord_123456:localhost", {
                    "bot": true,
                    "displayname": state.displayName,
                    "uk.half-shot.discord.member": {
                        id: "123456",
                        roles: state.roles,
                    },
                },
            );
        });
        it("Will set the displayColor correctly", async () => {
            const TEST_COLOR = 1234;
            const {userSync, bridge} = CreateUserSync([new RemoteUser("123456")]);
            const state: IGuildMemberState = {
                bot: false,
                displayColor: TEST_COLOR,
                displayName: "Good Boy",
                id: "123456",
                mxUserId: "@_discord_123456:localhost",
                roles: [ ],
                username: "",
            };
            await userSync.ApplyStateToRoom(state, "!abc:localhost", "12345678");
            bridge.getIntentForUserId("@_discord_123456:localhost").underlyingClient.sendStateEvent(
                "!abc:localhost",
                "m.room.member",
                "@_discord_123456:localhost", {
                    "bot": false,
                    "displayColor": TEST_COLOR,
                    "displayname": state.displayName,
                    "uk.half-shot.discord.member": {
                        id: "123456",
                        roles: state.roles,
                    },
                },
            );
        });
        it("Will set username correctly", async () => {
            const {userSync, bridge} = CreateUserSync([new RemoteUser("123456")]);
            const state: IGuildMemberState = {
                bot: false,
                displayColor: 0,
                displayName: "Good Boy",
                id: "123456",
                mxUserId: "@_discord_123456:localhost",
                roles: [ ],
                username: "user#1234",
            };
            await userSync.ApplyStateToRoom(state, "!abc:localhost", "12345678");
            bridge.getIntentForUserId("@_discord_123456:localhost").underlyingClient.sendStateEvent(
                "!abc:localhost",
                "m.room.member",
                "@_discord_123456:localhost", {
                    "bot": false,
                    "displayColor": 0,
                    "displayname": state.displayName,
                    "uk.half-shot.discord.member": {
                        id: "123456",
                        roles: state.roles,
                    },
                    "username": "user#1234",
                },
            );
        });
    });
    describe("GetUserStateForGuildMember", () => {
        it("Will apply a new nick", async () => {
            const {userSync} = CreateUserSync([new RemoteUser("123456")]);
            const guild = new MockGuild(
                "654321");
            const member = new MockMember(
                "123456",
                "username",
                guild,
                "BestDog");
            const state = await userSync.GetUserStateForGuildMember(member as any);
            expect(state.displayName).to.be.equal("BestDog");
        });
        it("Will will obay nick pattern", async () => {
            const {userSync} = CreateUserSync([new RemoteUser("123456")], { nickPattern: ":nick (Discord)" });
            const guild = new MockGuild(
                "654321");
            const member = new MockMember(
                "123456",
                "username",
                guild,
                "BestDog");
            const state = await userSync.GetUserStateForGuildMember(member as any);
            expect(state.displayName).to.be.equal("BestDog (Discord)");
        });
        it("Will correctly add roles", async () => {
            const {userSync} = CreateUserSync([new RemoteUser("123456")]);
            const guild = new MockGuild(
                "654321");
            const member = new MockMember(
                "123456",
                "username",
                guild,
                "BestDog");
            const TESTROLE_NAME = "testrole";
            const TESTROLE_COLOR = 1337;
            const TESTROLE_POSITION = 42;
            const role = new MockRole("123", TESTROLE_NAME, TESTROLE_COLOR, TESTROLE_POSITION);
            member.roles.cache.set("123", role);
            const state = await userSync.GetUserStateForGuildMember(member as any);
            expect(state.roles.length).to.be.equal(1);
            expect(state.roles[0].name).to.be.equal(TESTROLE_NAME);
            expect(state.roles[0].color).to.be.equal(TESTROLE_COLOR);
            expect(state.roles[0].position).to.be.equal(TESTROLE_POSITION);
        });
    });
    describe("GetUserStateForDiscordUser", () => {
        it("Will apply a new nick", async () => {
            const {userSync} = CreateUserSync([new RemoteUser("123456")]);
            const member = new MockUser(
                "123456",
                "username",
                "1234");
            const state = await userSync.GetUserStateForDiscordUser(member as any);
            expect(state.displayName).to.be.equal("username");
        });
        it("Will handle webhooks", async () => {
            const {userSync} = CreateUserSync([new RemoteUser("123456")]);
            const member = new MockUser(
                "123456",
                "username",
                "1234");
            const state = await userSync.GetUserStateForDiscordUser(member as any, true);
            expect(state.displayName).to.be.equal("username");
            expect(state.mxUserId).to.be.equal("@_discord_123456_username:localhost");
        });
    });
    describe("OnAddGuildMember", () => {
        it("will update user and join to rooms", async () => {
            const {userSync, bridge} = CreateUserSync([new RemoteUser("123456")]);
            const guild = new MockGuild(
                "654321");
            const member = new MockMember(
                "123456",
                "username",
                guild);
            await userSync.OnAddGuildMember(member as any);
            expect(bridge.getIntentForUserId("@_discord_123456:localhost")
                .underlyingClient.wasCalled("sendStateEvent")).to.equal(GUILD_ROOM_IDS.length);
        });
    });
    describe("OnRemoveGuildMember", () => {
        it("will leave users from rooms", async () => {
            const {userSync, bridge} = CreateUserSync([new RemoteUser("123456")]);
            const guild = new MockGuild(
                "654321");
            const member = new MockMember(
                "123456",
                "username",
                guild);
            await userSync.OnRemoveGuildMember(member as any);
            expect(bridge.getIntentForSuffix("123456")
                .underlyingClient.wasCalled("leaveRoom")).to.equal(GUILD_ROOM_IDS.length);
        });
    });
    describe("OnUpdateGuildMember", () => {
        it("will update state for rooms", async () => {
            const {userSync, bridge} = CreateUserSync([new RemoteUser("123456")]);
            const guild = new MockGuild(
                "654321");
            const newMember = new MockMember(
                "123456",
                "username",
                guild,
                "FiddleDee");
            await userSync.OnUpdateGuildMember(newMember as any);
            expect(bridge.getIntentForUserId("@_discord_123456:localhost")
                .underlyingClient.wasCalled("sendStateEvent")).to.equal(GUILD_ROOM_IDS.length);
        });
        it("will part rooms based on role removal", async () => {
            const {userSync, bridge} = CreateUserSync([new RemoteUser("123456")]);
            const role = new MockRole("1234", "role");
            const guild = new MockGuild(
                "654321");
            const newMember = new MockMember(
                "123456",
                "username",
                guild,
                "FiddleDee");
            newMember.roles.cache.set("1234", role);
            await userSync.OnUpdateGuildMember(newMember as any);
            expect(bridge.getIntentForUserId("@_discord_123456:localhost")
                .underlyingClient.wasCalled("sendStateEvent")).to.equal(GUILD_ROOM_IDS_WITH_ROLE.length);
            expect(bridge.getIntentForUserId("@_discord_123456:localhost")
                .underlyingClient.wasCalled("leaveRoom", true, "!ghi:localhost"))
                .to.equal(GUILD_ROOM_IDS.length - GUILD_ROOM_IDS_WITH_ROLE.length);
        });
    });
});
