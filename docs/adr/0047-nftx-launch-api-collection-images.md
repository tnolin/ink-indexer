# 0047. NFTX launch API as a collection image source

Date: 2026-11-25

Status: Accepted

## Context

A collection made by NFTX's launchpad has no NFTs until its auction ends and bidders claim, and its `contractURI()` and `baseURI()` are empty, so neither the chain nor OpenSea has an image for it while the auction runs. The auction announcements are built from the `nft.collection` event, whose `imageUrl` was filled only from OpenSea's collection page, so these cards went out without an image.

NFTX's launch page reads a public API, `GET https://api.nftx.io/v1/57073/launches?collection=<address>`. Each record carries the launch's collection address and a `profile` with `avatarUrl` and `bannerUrl`, served from `https://api.nftx.io/v1/media/ipfs/<cid>`. A collection with no launch gives an empty list, and a launch id the API does not know gives a 404 `LAUNCH_NOT_FOUND`. The profile can be filled in after the launch is created.

## Decision

**The avatar is the image of a launchpad collection that has none.** A job reads the launch record by collection address and sets `nft_collections.image_url` to `profile.avatarUrl`, which writes an `nft.collection` snapshot through the same path OpenSea's page does. It acts only on the record whose `collection` equals the collection asked for, and only on an avatar served from `https://api.nftx.io/v1/media/`. It does not change the verdict or the gates.

**OpenSea's image replaces it.** The lookup runs only while `image_url` is empty. OpenSea's collection page overwrites `image_url` when it names an image, and an OpenSea page with no image leaves the stored one in place.

**It runs beside the chain loop and is never waited on.** The job runs every minute while the `nftx` source is enabled, with no OpenSea key. A lookup has a 5 s timeout and three attempts, sends no credentials and a generic user agent. A collection whose record has no avatar yet, or whose lookup failed, is asked again after 5 minutes, then 30 minutes, then every 2 hours, until its auction ends. Ingestion and the cursor never depend on the API.

**Existing collections are covered by the same query.** It selects launchpad collections with no image whose auction has no end block, so a restart picks up collections created before the job existed. The schedule of misses is in memory and starts over after a restart. The collection address is the key, so no launch id is stored and no migration is needed.

## Consequences

- Launchpad auction cards carry an image from the first announcement the avatar exists for, instead of waiting for OpenSea.
- The image link is a URL on NFTX's API host. A consumer that downloads it depends on that host.
- A launch with no avatar at all is asked about every 2 hours until its auction ends.
