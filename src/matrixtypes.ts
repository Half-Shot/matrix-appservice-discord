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

export interface IMatrixEventContent {
    body?: string;
    info?: any;
    name?: string;
    topic?: string;
    membership?: string;
    msgtype?: string;
    url?: string;
    displayname?: string;
    avatar_url?: string;
    reason?: string;
    "m.relates_to"?: any;
}

export interface IMatrixEvent {
    event_id: string;
    state_key: string;
    type: string;
    sender: string;
    room_id: string;
    membership?: string;
    avatar_url?: string;
    displayname?: string;
    redacts?: string;
    replaces_state?: string;
    content?: IMatrixEventContent;
    unsigned?: any;
    origin_server_ts?: number;
    users?: any;
    users_default?: any;
    notifications?: any;
}

export interface IMatrixMessage {
    body: string;
    msgtype: string;
    formatted_body?: string;
    format?: string;
    "m.new_content"?: any;
    "m.relates_to"?: any;
}

export interface IMatrixMediaInfo {
    w?: number;
    h?: number;
    mimetype: string;
    size: number;
    duration?: number;
}
