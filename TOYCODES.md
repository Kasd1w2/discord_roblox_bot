# Toycode shop update

Extract `toycode-shop-update.zip` into your existing bot project and replace the included files at their matching paths:

- `index.js` (updated from your uploaded `index(1).js`)
- `commands/commandDefinitions.js` (updated from your uploaded command definitions)
- `utils/orderRuntime.js`
- `utils/orderStore.js`
- `utils/toycodeCatalog.js` (new)
- `utils/toycodeImages.js` (new)

Restart the bot. Startup registers `/toycodes` and the updated `/restock` options in your existing configured guild. Keep your existing models, package.json, environment variables, account/category files, `utils/helpers.js` and `utils/botStatus.js`. No new npm dependency or MongoDB cluster is needed.

## Post the shop

Shop staff use `/toycodes` in the shop channel, or select another channel:

```text
/toycodes channel:#toycodes
```

An optional `title` changes the public shop heading. The public embed has Browse Items and Search buttons. Each customer gets their own private browser, so browsing and filters do not change the public shop or another buyer's view.

The browser shows five items per page, each with a title, USD price and picture thumbnail. The item dropdown uses your `<:toycode:1556793052469657721>` emoji. Selecting an item shows its full image and a Buy / Open Ticket button. Discord select options support text and emojis; item images appear in the cards and selected-item embed, rather than inside the dropdown itself.

Search matches part of the item title, ignoring letter case. Price ranges, search and sorting work together and stay applied when changing pages. Previous/Next, Refresh and Reset Filters are included. Sort by price low to high or high to low.

| Price filter | Included USD prices |
| --- | --- |
| All prices | Every listed item |
| $0–$99.99 | Below $100 |
| $100–$499.99 | At least $100, below $500 |
| $500–$999.99 | At least $500, below $1,000 |
| $1,000+ | At least $1,000 |

Listings show no stock quantities or private codes. An item remains listed even when it has no inventory codes, so staff can sell and deliver it manually. Browsing sessions expire after 30 minutes without activity; reopen Browse Items to continue after expiry or a bot restart. Catalog items persist across restarts.

## Restock a toycode item

Provide all three toycode fields:

```text
/restock title:Golden Horns price:250 image_url:https://example.com/horns.png
```

Use a public direct PNG, JPG, GIF or WebP file under 6 MB. Prices must be positive USD amounts with up to two decimal places. Titles support up to 100 characters. Invalid metadata or a failed image download leaves the catalog unchanged.

The private confirmation gives you the stock ID. Restocking the same title in the same server updates its listing instead of creating a duplicate (case-insensitive). To rename an existing item or connect it to a stock ID you already use, supply `item_id`:

```text
/restock item_id:golden_horns title:Golden Horns price:250 image_url:https://example.com/horns.png
```

The optional `codes` field stores private delivery codes under this stock ID. It is not needed to create a listing. Code entries retain the existing comma/newline/space-separated format. Account category IDs cannot be used as toycode IDs.

Existing account/code restocking continues to work without toycode fields:

```text
/restock item_id:4l codes:noah:example-password:12.50
```

Your public shop refreshes from the database whenever someone browses; no repost is needed after restocking.

## Where images are saved

Each toycode restock copies the image into a bot embed with a Discord file attachment **in the channel where you run `/restock`**. Run the command in a staff channel if you want these source posts kept away from customers. The post contains only the title, price and image. The restock confirmation remains private.

You can choose a dedicated image channel by setting `TOYCODE_IMAGE_CHANNEL_ID` to its Discord channel ID and restarting. The channel must belong to the shop server. The bot needs View Channel, Send Messages, Embed Links, Attach Files and Read Message History there. Keep these image posts: the shop fetches their current attachment URLs when displaying a page, preview or checkout, avoiding expired source links. Deleting an image post leaves the item browsable without a picture; restock it with a fresh image to restore it. Previous source posts are kept because open orders may still reference them.

MongoDB stores catalog metadata and image message references in `shop_toycode_items`; image bytes stay in Discord. Page clicks, searches and browsing sessions do not create MongoDB documents. Existing stock codes stay in Inventory.

## Orders and delivery

Buy opens your existing private tracked ticket with the selected title, saved price and image. The current price and title are checked again inside the order transaction; a stale selection asks the buyer to select the item again. Existing duplicate-ticket and cooldown protections still apply.

Coupons, Stripe with the existing 5% fee, Crypto and other payment methods use the existing checkout flow. Stripe confirms payment and awards points automatically; staff deliver the item. If you stocked actual codes, use `/deliver` with the buyer and stock ID in the matching ticket. If you deliver manually, send the item/code to the buyer and finish with `/close status:success`. Existing warranty terms cover toycode items for seven days from delivery.

## Verification

All 87 offline tests and JavaScript syntax checks passed. Tests cover range boundaries, search combined with sorting/paging, more than 25 items, images, restocking validation, private-code protection, ownership/guild checks, stale quotes, ticket creation, Stripe/coupon/points behavior and staff delivery, plus the existing account, ticket and transcript flows. Live Discord, Stripe and MongoDB connections were not tested.
