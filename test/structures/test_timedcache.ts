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
import { TimedCache } from "../../src/structures/timedcache";
import { Util } from "../../src/util";

describe("TimedCache", () => {
    it("should construct", () => {
        const timedCache = new TimedCache<string, number>(1000);
        expect(timedCache.size).to.equal(0);
    });

    it("should add and get values", () => {
        const timedCache = new TimedCache<string, number>(1000);
        timedCache.set("foo", 1);
        timedCache.set("bar", -1);
        timedCache.set("baz", 0);
        expect(timedCache.get("foo")).to.equal(1);
        expect(timedCache.get("bar")).to.equal(-1);
        expect(timedCache.get("baz")).to.equal(0);
    });

    it("should be able to overwrite values", () => {
        const timedCache = new TimedCache<string, number>(1000);
        timedCache.set("foo", 1);
        expect(timedCache.get("foo")).to.equal(1);
        timedCache.set("bar", 0);
        timedCache.set("foo", -1);
        expect(timedCache.get("bar")).to.equal(0);
        expect(timedCache.get("foo")).to.equal(-1);
    });

    it("should be able to check if a value exists", () => {
        const timedCache = new TimedCache<string, number>(1000);
        expect(timedCache.has("foo")).to.be.false;
        timedCache.set("foo", 1);
        expect(timedCache.has("foo")).to.be.true;
        timedCache.set("bar", 1);
        expect(timedCache.has("bar")).to.be.true;
    });

    it("should be able to delete a value", () => {
        const timedCache = new TimedCache<string, number>(1000);
        timedCache.set("foo", 1);
        expect(timedCache.has("foo")).to.be.true;
        timedCache.delete("foo");
        expect(timedCache.has("foo")).to.be.false;
        expect(timedCache.get("foo")).to.be.undefined;
    });

    it("should expire a value", async () => {
        const LIVE_FOR = 50;
        const timedCache = new TimedCache<string, number>(LIVE_FOR);
        timedCache.set("foo", 1);
        expect(timedCache.has("foo")).to.be.true;
        expect(timedCache.get("foo")).to.equal(1);
        await Util.DelayedPromise(LIVE_FOR);
        expect(timedCache.has("foo")).to.be.false;
        expect(timedCache.get("foo")).to.be.undefined;
    });

    it("should be able to iterate around a long-lasting collection", () => {
        const timedCache = new TimedCache<string, number>(1000);
        timedCache.set("foo", 1);
        timedCache.set("bar", -1);
        timedCache.set("baz", 0);
        let i = 0;
        for (const iterator of timedCache) {
            if (i === 0) {
                expect(iterator[0]).to.equal("foo");
                expect(iterator[1]).to.equal(1);
            } else if (i === 1) {
                expect(iterator[0]).to.equal("bar");
                expect(iterator[1]).to.equal(-1);
            } else {
                expect(iterator[0]).to.equal("baz");
                expect(iterator[1]).to.equal(0);
            }
            i++;
        }
    });

    it("should be able to iterate around a short-term collection", async () => {
        const LIVE_FOR = 100;
        const timedCache = new TimedCache<string, number>(LIVE_FOR);
        timedCache.set("foo", 1);
        timedCache.set("bar", -1);
        timedCache.set("baz", 0);
        let i = 0;
        for (const iterator of timedCache) {
            if (i === 0) {
                expect(iterator[0]).to.equal("foo");
                expect(iterator[1]).to.equal(1);
            } else if (i === 1) {
                expect(iterator[0]).to.equal("bar");
                expect(iterator[1]).to.equal(-1);
            } else {
                expect(iterator[0]).to.equal("baz");
                expect(iterator[1]).to.equal(0);
            }
            i++;
        }
        await Util.DelayedPromise(LIVE_FOR * 5);
        const vals = [...timedCache.entries()];
        expect(vals).to.be.empty;
    });
});
