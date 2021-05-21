/*
Copyright 2018, 2019 matrix-appservice-discord

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

import { Util, ICommandActions, ICommandParameters } from "../src/util";
import { AppserviceMock } from "./mocks/appservicemock";

function CreateMockIntent(members): any {
    const as = new AppserviceMock({
        roommembers: members.map((member) =>
            ({
                content: {
                    displayname: member.displayname,
                },
                membership: member.membership,
                stateKey: member.mxid,
            }),
        ),
    });
    return as.botIntent;
}

describe("Util", () => {
    describe("MsgToArgs", () => {
        it("parses arguments", () => {
            const {command, args} = Util.MsgToArgs("!matrix command arg1 arg2", "!matrix");
            expect(command).to.be.eq("command");
            expect(args.length).to.be.eq(2);
            expect(args[0]).to.be.eq("arg1");
            expect(args[1]).to.be.eq("arg2");
        });
    });
    describe("Command Stuff", () => {
        const actions: ICommandActions = {
            action: {
                description: "floof",
                help: "Fox goes floof!",
                params: ["param1", "param2"],
                run: async ({param1, param2}) => {
                    return `param1: ${param1}\nparam2: ${param2}`;
                },
            },
        };
        const parameters: ICommandParameters = {
            param1: {
                description: "1",
                get: async (param: string) => {
                    return "param1_" + param;
                },
            },
            param2: {
                description: "2",
                get: async (param: string) => {
                    return "param2_" + param;
                },
            },
        };
        describe("HandleHelpCommand", () => {
            it("handles empty commands", async () => {
                const {args} = Util.MsgToArgs("!fox help", "!fox");
                const retStr = await Util.HandleHelpCommand(
                    "!fox",
                    {} as any,
                    {} as any,
                    args,
                );
                expect(retStr).to.equal("No commands found");
            });
            it("parses general help message", async () => {
                const {args} = Util.MsgToArgs("!fox help", "!fox");
                const retStr = await Util.HandleHelpCommand(
                    "!fox",
                    actions,
                    parameters,
                    args,
                );
                expect(retStr).to.equal(
                    `Available Commands:
 - \`!fox action <param1> <param2>\`: floof

Parameters:
 - \`<param1>\`: 1
 - \`<param2>\`: 2
`);
            });
            it("parses specific help message", async () => {
                const {args} = Util.MsgToArgs("!fox help action", "!fox");
                const retStr = await Util.HandleHelpCommand(
                    "!fox",
                    actions,
                    parameters,
                    args,
                );
                expect(retStr).to.equal(
                    `\`!fox action <param1> <param2>\`: floof
Fox goes floof!`);
            });
        });
        describe("ParseCommand", () => {
            it("parses commands", async () => {
                const retStr = await Util.ParseCommand(
                    "!fox",
                    "!fox action hello world",
                    actions,
                    parameters,
                );
                expect(retStr).equal("param1: param1_hello\nparam2: param2_world");
            });
        });
    });
    describe("GetMxidFromName", () => {
        it("Finds a single member", async () => {
            const mockUsers = [
                {
                    displayname: "GoodBoy",
                    membership: "join",
                    mxid: "@123:localhost",
                },
            ];
            const intent = CreateMockIntent(mockUsers);
            const mxid = await Util.GetMxidFromName(intent, "goodboy", ["abc"]);
            expect(mxid).equal("@123:localhost");
        });
        it("Errors on multiple members", async () => {
            const mockRooms = [
                {
                    displayname: "GoodBoy",
                    membership: "join",
                    mxid: "@123:localhost",
                },
                {
                    displayname: "GoodBoy",
                    membership: "join",
                    mxid: "@456:localhost",
                },
            ];
            const intent = CreateMockIntent(mockRooms);
            try {
                await Util.GetMxidFromName(intent, "goodboy", ["abc"]);
                throw new Error("didn't fail");
            } catch (e) {
                expect(e.message).to.not.equal("didn't fail");
            }
        });
        it("Errors on no member", async () => {
            const mockRooms = [
                {
                    displayname: "GoodBoy",
                    membership: "join",
                    mxid: "@123:localhost",
                },
            ];
            const intent = CreateMockIntent(mockRooms);
            try {
                await Util.GetMxidFromName(intent, "badboy", ["abc"]);
                throw new Error("didn't fail");
            } catch (e) {
                expect(e.message).to.not.equal("didn't fail");
            }
        });
    });
    describe("NumberToHTMLColor", () => {
        it("Should handle valid colors", () => {
            const COLOR = 0xdeadaf;
            const reply = Util.NumberToHTMLColor(COLOR);
            expect(reply).to.equal("#deadaf");
        });
        it("Should reject too large colors", () => {
            const COLOR = 0xFFFFFFFF;
            const reply = Util.NumberToHTMLColor(COLOR);
            expect(reply).to.equal("#ffffff");
        });
        it("Should reject too small colors", () => {
            const COLOR = -1;
            const reply = Util.NumberToHTMLColor(COLOR);
            expect(reply).to.equal("#000000");
        });
    });
    describe("ApplyPatternString", () => {
        it("Should apply simple patterns", () => {
            const reply = Util.ApplyPatternString(":name likes :animal", {
                animal: "Foxies",
                name: "Sorunome",
            });
            expect(reply).to.equal("Sorunome likes Foxies");
        });
        it("Should ignore unused tags", () => {
            const reply = Util.ApplyPatternString(":name is :thing", {
                name: "Sorunome",
            });
            expect(reply).to.equal("Sorunome is :thing");
        });
        it("Should do multi-replacements", () => {
            const reply = Util.ApplyPatternString(":animal, :animal and :animal", {
                animal: "fox",
            });
            expect(reply).to.equal("fox, fox and fox");
        });
    });
    describe("DelayedPromise", () => {
        it("delays for some time", async () => {
            const DELAY_FOR = 250;
            const t = Date.now();
            await Util.DelayedPromise(DELAY_FOR);
            expect(Date.now()).to.be.greaterThan(t + DELAY_FOR - 1);
        });
    });
    describe("CheckMatrixPermission", () => {
        const PERM_LEVEL = 50;
        it("should deny", async () => {
            const ret = await Util.CheckMatrixPermission(
                {
                    getRoomStateEvent: async () => {
                        return {
                            blah: {
                                blubb: PERM_LEVEL,
                            },
                        };
                    },
                } as any,
                "@user:localhost",
                "",
                PERM_LEVEL,
                "blah",
                "blubb",
            );
            expect(ret).to.be.false;
        });
        it("should allow cat/subcat", async () => {
            const ret = await Util.CheckMatrixPermission(
                {
                    getRoomStateEvent: async () => {
                        return {
                            blah: {
                                blubb: PERM_LEVEL,
                            },
                            users: {
                                "@user:localhost": PERM_LEVEL,
                            },
                        };
                    },
                } as any,
                "@user:localhost",
                "",
                PERM_LEVEL,
                "blah",
                "blubb",
            );
            expect(ret).to.be.true;
        });
        it("should allow cat", async () => {
            const ret = await Util.CheckMatrixPermission(
                {
                    getRoomStateEvent: async () => {
                        return {
                            blah: PERM_LEVEL,
                            users: {
                                "@user:localhost": PERM_LEVEL,
                            },
                        };
                    },
                } as any,
                "@user:localhost",
                "",
                PERM_LEVEL,
                "blah",
            );
            expect(ret).to.be.true;
        });
        it("should allow based on default", async () => {
            const ret = await Util.CheckMatrixPermission(
                {
                    getRoomStateEvent: async () => {
                        return {
                            blah: PERM_LEVEL,
                            users_default: PERM_LEVEL,
                        };
                    },
                } as any,
                "@user:localhost",
                "",
                PERM_LEVEL,
                "blah",
            );
            expect(ret).to.be.true;
        });
    });
    describe("EscapeStringForUserId", () => {
        it("should encode a string properly", () => {
            expect(Util.EscapeStringForUserId("ThisIsAString")).to
                .equal("=54his=49s=41=53tring");
            expect(Util.EscapeStringForUserId('1!2"3£4$5%6^7&8*9(0)')).to
                .equal("1=212=223=a34=245=256=5e7=268=2a9=280=29");
        });
        it("should not-reencode a string", () => {
            expect(Util.EscapeStringForUserId("=54his=49s=41=53tring")).to
                .equal("=54his=49s=41=53tring");
            expect(Util.EscapeStringForUserId("1=212=223=a34=245=256=5e7=268=2a9=280=29")).to
                .equal("1=212=223=a34=245=256=5e7=268=2a9=280=29");
        });
    });
});
