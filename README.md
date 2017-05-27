# Matrix Discord Bridge

A bridge between [Matrix](http://matrix.org/) and [Discord](https://discordapp.com/).
Currently the bridge is alpha quality, but is usable.

![Screenshot of Riot and Discord working together](screenshot.png)

## Helping out

[![Build Status](https://travis-ci.org/Half-Shot/matrix-appservice-discord.svg?branch=develop)](https://travis-ci.org/Half-Shot/matrix-appservice-discord)

### PRs
PRs are graciously accepted, so please come talk to us in [#discord-bridge:matrix.org](https://matrix.to/#/#discord-bridge:matrix.org)
about any neat ideas you might have. If you are going to make a change, please merge it with the `develop` branch :).

### Issues
You can also file bug reports/ feature requests on Github Issues which also helps a ton. Please remember to include logs.
Please also be aware that this is an unoffical project worked on in my (Half-Shot) spare time.

## Setting up

(These instructions were tested against Node.js v6.9.5 and the Synapse homeserver)

### Setup the bridge

* Run ``npm install`` to grab the dependencies.
* Run ``npm run-script build`` to build the typescript.
* Copy ``config/config.sample.yaml`` to ``config.yaml`` and edit it to reflect your setup.
* Run ``node build/src/discordas.js -r -u "http://localhost:9005" -c config.yaml``
* Modify your HSs appservices config so that it includes the generated file.

#### 3PID Protocol Support

This bridge support searching for rooms within networks via the 3pid system
used in clients like [Riot](https://riot.im). However, it requires a small manual change
to your registration file. Add ``protocols: ["discord"]`` to the end and restart both your bridge
and synapse. Any new servers/guilds you bridge should show up in the network list on Riot and other clients.

### Setting up Discord

* Create a new application via https://discordapp.com/developers/applications/me/create
* Make sure to create a bot user. Fill in ``config.yaml``
* Run ``npm run-script getbotlink`` to get a authorisation link.
* Give this link to owners of the guilds you plan to bridge.
* Finally, you can join a room with ``#_discord_guildid_channelid``
  * These can be taken from the url ("/$GUILDID/$CHANNELID") when you are in a channel.  
  * Riot (and other clients with third party protocol support) users can directly join channels from the room directory.

### Settings up Webhooks (optional)

This allows messages to be directly posted in the discord chat with the display name of the matrix user, rather than as embeds posted by the bot.
* Go into the discord server settings and add a webhook for the channel you want. Name the webhook ``_matrix``
* If you used the auth link recently it should have the correct permissions, otherwise check the bot has permission to ``Manage Webhooks`` on discord.

## Features and Roadmap
In a vague order of what is coming up next

 - Matrix -> Discord
   - [x] Text content
   - [x] Image content
   - [x] Audio/Video content
   - [ ] Typing notifs (**Not supported, requires syncing**)
   - [x] User Profiles
 - Discord -> Matrix
   - [x] Text content
   - [x] Image content
   - [x] Audio/Video content
   - [x] Typing notifs
   - [x] User Profiles
   - [x] Presence
   - [x] Per-guild display names.
 - [x] Group messages
 - [ ] Third Party Lookup
  - [x] Rooms
  - [ ] Users
 - [ ] Puppet a user's real Discord account.
  - [x] Sending messages
  - [ ] Direct messages
  - [ ] UI for setup
 - [x] Rooms react to Discord updates
 - [ ] Integrate Discord into existing rooms
  - [x] Feature
  - [ ] UI
 - [ ] Manage channel from Matrix (possibly)
  - [ ] Authorise admin rights from Discord to Matrix users
  - [ ] Topic
  - [ ] Room Name
 - [ ] Provisioning API
 - [ ] Webhooks (allows for prettier messages to discord)
 - [ ] VOIP (**Hard** | Unlikely to be finished anytime soon)


## Contact

My Matrix ID: [@Half-Shot:half-shot.uk](https://matrix.to/#/@Half-Shot:half-shot.uk)
