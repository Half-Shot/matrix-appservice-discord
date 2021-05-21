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
import { Provisioner } from "../src/provisioner";
import { MockChannel } from "./mocks/channel";
import { MockMember } from "./mocks/member";

const TIMEOUT_MS = 1000;

describe("Provisioner", () => {
    describe("AskBridgePermission", () => {
        it("should fail to bridge a room that timed out", async () => {
            const p = new Provisioner({} as any, {} as any);
            const startAt = Date.now();
            try {
                await p.AskBridgePermission(
                    new MockChannel("foo", "bar") as any,
                    "Mark",
                    TIMEOUT_MS,
                );
                throw Error("Should have thrown an error");
            } catch (err) {
                expect(err.message).to.eq("Timed out waiting for a response from the Discord owners.");
                const delay = Date.now() - startAt;
                if (delay < TIMEOUT_MS) {
                    throw Error(`Should have waited for timeout before resolving, waited: ${delay}ms`);
                }
            }
        });
        it("should fail to bridge a room that was declined", async () => {
            const p = new Provisioner({} as any, {} as any);
            const promise = p.AskBridgePermission(
                new MockChannel("foo", "bar") as any,
                "Mark",
                TIMEOUT_MS,
            );
            await p.MarkApproved(new MockChannel("foo", "bar") as any, new MockMember("abc", "Mark") as any, false);
            try {
                await promise;
                throw Error("Should have thrown an error");
            } catch (err) {
                expect(err.message).to.eq("The bridge has been declined by the Discord guild.");
            }

        });
        it("should bridge a room that was approved", async () => {
            const p = new Provisioner({} as any, {} as any);
            const promise = p.AskBridgePermission(
                new MockChannel("foo", "bar") as any,
                "Mark",
                TIMEOUT_MS,
            );
            await p.MarkApproved(new MockChannel("foo", "bar") as any, new MockMember("abc", "Mark") as any, true);
            expect(await promise).to.eq("Approved");
        });
    });
    describe("RoomCountLimitReached", () => {
        it("should return false if no limit is defined", async () => {
            const p = new Provisioner({
                countEntries: async () => 7,
            } as any, {} as any);
            expect(await p.RoomCountLimitReached(-1)).to.equal(false);
        });
        it("should return false if less rooms exist than the limit", async () => {
            const p = new Provisioner({
                countEntries: async () => 7,
            } as any, {} as any);
            expect(await p.RoomCountLimitReached(10)).to.equal(false);
        });
        it("should return true if more rooms exist than the limit", async () => {
            const p = new Provisioner({
                countEntries: async () => 7,
            } as any, {} as any);
            expect(await p.RoomCountLimitReached(5)).to.equal(true);
        });
        it("should return true if there are as many rooms as the limit allows", async () => {
            const p = new Provisioner({
                countEntries: async () => 7,
            } as any, {} as any);
            expect(await p.RoomCountLimitReached(7)).to.equal(true);
        });
    });
});
