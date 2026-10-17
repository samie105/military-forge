# 99 — Sources

Research done on 16 Oct 2026 by five parallel research passes. Sources marked *(unverified)* came from a single secondary source. Re-check prices and versions before committing.

## Netcode
- Gaffer on Games — snapshot interpolation & compression: https://gafferongames.com/post/snapshot_interpolation/ · https://gafferongames.com/post/snapshot_compression/
- Valve — Source multiplayer networking & lag compensation: https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking · https://developer.valvesoftware.com/wiki/Lag_Compensation
- Gabriel Gambetta — Fast-Paced Multiplayer: https://www.gabrielgambetta.com/client-server-game-architecture.html
- Overwatch GDC 2017 (Tim Ford): https://gdcvault.com/play/1024001/-Overwatch-Gameplay-Architecture-and
- Riot — VALORANT 128-tick: https://technology.riotgames.com/node/112
- Epic — Replication Graph: https://dev.epicgames.com/documentation/en-us/unreal-engine/replication-graph-in-unreal-engine
- Colyseus 0.18: https://colyseus.io/blog/colyseus-018-is-here/ · netcode docs https://docs.colyseus.io/netcode · WebTransport transport https://docs.colyseus.io/server/transport/webtransport
- Nakama authoritative matches: https://heroiclabs.com/docs/nakama/concepts/multiplayer/authoritative/
- WebTransport: MDN https://developer.mozilla.org/docs/Web/API/WebTransport_API · IETF draft-16 https://www.ietf.org/archive/id/draft-ietf-webtrans-http3-16.html · cross-engine quirks https://echo.semantic-ui.com/compat · caniuse https://caniuse.com/webtransport
- Rust WebTransport: https://docs.rs/wtransport/ · https://doc.moq.dev/rs/crate/web-transport
- geckos.io: https://github.com/geckosio/geckos.io
- JS determinism: https://webassembly.org/docs/nondeterminism/ · https://developers.rune.ai/blog/making-js-deterministic-for-fun-and-glory/
- Aimbot detection research: https://arxiv.org/pdf/2409.14830

## Hosting & infrastructure
- Hathora shutdown: https://www.techspot.com/news/111969-stormgate-servers-go-dark-following-ai-focused-hosting.html · https://gameye.com/blog/game-server-shake-up-2026
- Unity Multiplay notice: https://status.unity.com/info_notices/362941
- AWS GameLift: pricing https://aws.amazon.com/gamelift/servers/pricing/ · free bandwidth https://aws.amazon.com/about-aws/whats-new/2026/06/amazon-gamelift-servers-free-network-bandwidth/ · locations https://docs.aws.amazon.com/gameliftservers/latest/developerguide/gamelift-regions.html · Anywhere https://aws.amazon.com/gamelift/pricing/anywhere-pricing/
- Edgegap: https://edgegap.com/resources/pricing · ping beacons https://docs.edgegap.com/learn/orchestration/ping-beacons
- Gameye: https://www.gameye.com/pricing/ · Rivet: https://rivet.dev/cloud/ · Fly.io: https://fly.io/docs/about/pricing/
- Agones (CNCF): https://www.cncf.io/blog/2026/03/23/agones-moves-to-the-cncf-a-new-era-for-open-source-multiplayer-game-infrastructure/
- Cloudflare: Durable Objects pricing/limits/placement https://developers.cloudflare.com/durable-objects/platform/pricing/ · https://developers.cloudflare.com/durable-objects/reference/data-location/ · WebSockets https://developers.cloudflare.com/network/websockets · R2 https://developers.cloudflare.com/r2/pricing · Spectrum https://developers.cloudflare.com/spectrum/
- Hetzner price change: https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/
- OVH game servers: https://www.ovhcloud.com/en/bare-metal/uc-gaming/
- Vultr bandwidth: https://docs.vultr.com/support/platform/billing/how-are-bandwidth-caps-calculated · DigitalOcean https://docs.digitalocean.com/platform/billing/bandwidth/ · Akamai https://www.linode.com/docs/guides/network-transfer/
- Lagos: AWS Local Zone https://aws-pricing.com/af-south-1-los-1.html · Zenlayer https://www.zenlayer.com/global/countries/nigeria · Rack Centre https://techcabal.com/2025/04/14/rack-centres-lgs2-12mw-data-centre-gamechanger-to-revolutionise-nigerias-digital-landscape/
- Latency data: https://wondernetwork.com/pings/Lagos · https://wondernetwork.com/pings/Mumbai · https://wondernetwork.com/pings/Dubai
- AWS Middle East incident: https://www.theregister.com/2026/03/02/amazon_outages_middle_east/
- Neon: https://neon.com/pricing · Better Auth anonymous: https://better-auth.com/docs/plugins/anonymous · Clerk pricing: https://clerk.com/articles/clerk-pricing-explained

## Client tech
- Three.js releases: https://github.com/mrdoob/three.js/releases · WebGPURenderer https://threejs.org/docs/pages/WebGPURenderer.html
- Babylon.js 9: https://blogs.windows.com/windowsdeveloper/2026/03/26/announcing-babylon-js-9-0/
- Godot web export: https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_web.html
- Rapier determinism & character controller: https://rapier.rs/docs/user_guides/javascript/determinism · https://rapier.rs/docs/user_guides/javascript/character_controller
- Box2D v3 determinism & mover: https://box2d.org/posts/2024/08/determinism/ · https://box2d.org/documentation/md_character.html · https://cdn.jsdelivr.net/npm/box2d3-wasm@5.2.0/README.md
- bitECS serialization: https://cdn.jsdelivr.net/npm/bitecs@0.4.0/docs/Serialization.md · Koota https://github.com/pmndrs/koota
- meshoptimizer: https://meshoptimizer.org/v1.html · GLTFLoader https://threejs.org/docs/pages/GLTFLoader.html
- WebGPU support: https://web.dev/blog/webgpu-supported-major-browsers · Document-Isolation-Policy https://developer.chrome.com/blog/document-isolation-policy
- Browser games stack list *(partly unverified)*: https://rpaladin.github.io/browser-games-list/

## Portals, monetisation & payments
- CrazyGames requirements: https://docs.crazygames.com/requirements/intro/ · technical https://docs.crazygames.com/requirements/technical/ · multiplayer https://docs.crazygames.com/requirements/multiplayer/ · accounts https://docs.crazygames.com/requirements/account-integration/ · SDK https://docs.crazygames.com/sdk/html5-v3/game/
- Poki: https://sdk.poki.com/sdk-documentation.html · https://developers.poki.com/guide/requirements-quality
- GameDistribution SDK: https://github.com/GameDistribution/GD-HTML5/wiki/SDK-Implementation
- Stripe UPI: https://docs.stripe.com/payments/upi · Razorpay UPI intent: https://razorpay.com/docs/payments/payment-methods/upi-intent · Xsolla: https://xsolla.com
- Battle pass design: https://www.gamerefinery.com/seven-ways-to-take-battle-passes-to-the-next-level/

## Battle royale, matchmaking, social
- survev (open-source surviv.io): https://github.com/survev/survev
- Fortnite storm/knock/reboot: https://fortnite-archive.fandom.com/wiki/The_Storm_(Battle_Royale) · https://fortnite.fandom.com/wiki/Rebooting
- Battlelands Royale: https://deconstructoroffun.com/blog/2018/8/23/battlelands-royale-contender-or-pretender
- Bots in BR: https://invenglobal.com/articles/9134/fortnite-is-adding-bots-to-matches-to-help-new-players-learn-the-game · https://bloodhunt.com/news/upcoming-changes-to-the-trios-matchmaker
- OpenSkill: https://www.npmjs.com/package/openskill · https://arxiv.org/html/2401.05451v1 · TrueSkill 2: https://www.microsoft.com/en-us/research/publication/trueskill-2-improved-bayesian-skill-rating-system/
- Backfill: https://docs.unity.com/matchmaker/backfill.html
- LiveKit: https://github.com/livekit/livekit · Fortnite voice reporting: https://www.epicgames.com/site/en-US/news/introducing-voice-reporting-in-fortnite
- Apex ping system: https://www.pcgamer.com/au/apex-legends-ping-system-is-a-tiny-miracle-for-fps-teamwork-and-communication/
- iOS Web Push: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- Smurf detection (Valorant): https://playvalorant.com/en-us/news/dev/valorant-systems-health-series-smurf-detection/

## Law, compliance, accessibility
- Loot boxes: Brazil https://www.pocketgamer.biz/brazil-bans-loot-boxes-for-under-18s-in-online-child-safety-measure · Belgium https://publicgaming.com/news-categories-m/legal/2875-belgium-defines-video-game-loot-boxes-as-illegal-gambling · Australia https://www.pcworld.com/article/2464538/all-games-with-loot-boxes-will-be-rated-m-or-higher-in-australia.html
- EU virtual currency principles: https://connectontech.bakermckenzie.com/european-consumer-protection-network-issues-new-key-principles-on-in-game-virtual-currencies-impact-for-gaming-and-gambling-entities-in-belgium-the-eu-and-beyond/
- COPPA amended rule: https://www.finnegan.com/en/insights/articles/coppas-amended-rule-is-now-in-full-effect-what-operators-need-to-know.html
- India DPDP Rules: https://www.scconline.com/blog/post/2025/12/26/digital-personal-data-protection-rules-2025-key-highlights/
- Nigeria NDPA: https://www.dlapiperdataprotection.com/?c=NG&t=law
- UK Online Safety Act (games): https://www.cooley.com/news/insight/2025/2025-04-09-the-online-safety-act-child-access-duties-for-the-gaming-industry
- EU DSA for studios: https://blog.promise.legal/eu-digital-services-act-game-studios/
- European Accessibility Act: https://igda-gasig.org/what-and-why/demystifying-eaa-gpsr/
- Game Accessibility Guidelines: https://gameaccessibilityguidelines.com/
- Retention benchmarks: https://gamedevreports.substack.com/p/gameanalytics-mobile-and-pc-game
- Balance heatmaps: https://www.gameanalytics.com/blog/balance-and-flow-maps

## In-world advertising (14)
Researched 17 Oct 2026. The full list, including the regulation links, is in [14 §9.2](14-in-world-advertising.md#92-sources).
- Lagos Life ad page: https://lagoslife.app/advertise · Techpoint launch pricing https://techpoint.africa/news/lagos-life-1m-players/ · TechCabal ad counts *(unverified, from search extracts)* https://techcabal.com/2026/10/12/lagos-life-advertising-revenue-running-costs/ · MarketingEdge (the 43-ad board) https://marketingedge.com.ng/lagos-life-turns-virtual-lagos-into-a-new-frontier-for-brand-marketing/ · FIJ on the illegal ads https://fij.ng/article/spotted-viral-lagos-life-game-hosts-illegal-website-pimping-sex-workers/ · Innovation Village (terms) https://innovation-village.com/lagos-life-game-draws-scrutiny-over-virtual-currency-payments-and-player-data/
- Earlier Nigerian games' ad revenue: https://technext24.com/3en1
- IAB/MRC Intrinsic In-Game Measurement Guidelines 2.0: https://www.iab.com/wp-content/uploads/2022/08/In-Game-Advertising-Measurment-Guidelines_08.31.2022.pdf · IAB gaming creative guidelines (2024): https://www.iab.com/wp-content/uploads/2024/03/IAB_Creative_Guidelines_Best_Practices_Advertising_Gaming_March_2024.pdf
- Anzu × Playgama (web intrinsic ads): https://gamesbeat.com/playgama-and-anzu-bring-real-world-ads-to-web-games/ · https://wiki.playgama.com/playgama/guides/monetization/intrinsic-ads.md · Bidstack administration: https://www.exchangewire.com/blog/2024/03/25/acquisition-of-bidstack-ltd-all-operating-subsidiaries/
- Price benchmarks: Meta CPM in Nigeria https://grey.co/blog/facebook-ads-cost-nigeria · Lagos LED rates *(vendor claims, unaudited)* https://oxbillboards.com/blog/how-much-does-a-billboard-cost-in-lagos-2026/ · Ludo King ad rates *(low confidence)* https://www.themediaant.com/digital/ludo-king-app-advertising
- ARCON vetting fees: https://nairametrics.com/2023/05/11/nigerians-to-pay-more-for-social-media-ads-as-arcon-releases-vetting-rates/ · ARCON Act synopsis https://www.templars-law.com/app/uploads/2022/11/Advertising-in-Nigeria-A-Synopsis-of-Recent-Regulatory-Developments-VS-edits.pdf · India Online Gaming Act 2025 https://www.indiacode.nic.in/bitstream/123456789/22148/1/a2025-32.pdf · DPDP timeline https://india-briefing.com/news/india-dpdp-compliance-timeline-enforcement-2026-27-44740.html · UK HFSS ad ban https://www.iabuk.com/news-article/less-healthy-food-and-drink-ad-ban-what-it-how-it-works · EDPB 2/2023 https://edpb.europa.eu:443/system/files/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf
- Still to add *(cited in the review pass)*: MarketingEdge on ARCON's accelerated vetting tiers; BusinessDay on ARCON's ₦1m notices (Mar 2026); StatCounter desktop-vs-mobile share for Nigeria and India (https://gs.statcounter.com/)
