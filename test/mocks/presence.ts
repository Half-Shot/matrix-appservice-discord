import { MockUser } from "./user";
export class MockPresence {
    constructor(public internalUser: MockUser, guild: string, public status?: string, public activities: any = []) {

    }

    public get user() {
        return this.internalUser;
    }

    public get userID() {
        return this.internalUser.id;
    }
}
