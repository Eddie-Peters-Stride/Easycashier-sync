## Shopify to Easycashier sync application

### EasyCashier authentication

Configure these private Gadget environment variables in each environment:

- `EASYCASHIER_API_BASE_URL`
- `EASYCASHIER_COMPANY_ID`
- `EASYCASHIER_API_USERNAME`
- `EASYCASHIER_API_PASSWORD`

`EASYCASHIER_LOGIN_URL` is optional and defaults to
`https://backoffice.easycashier.se/v1/login`.

API requests send the returned access token using the client's configured
authentication header. The header name can be overridden with
`EASYCASHIER_API_AUTH_HEADER_NAME` if required.

### Inventory location mapping

Map each EasyCashier store to its Shopify location ID using private Gadget
environment variables:

- `EASYCASHIER_STORE_1_SHOPIFY_LOCATION_ID`
- `EASYCASHIER_STORE_3_SHOPIFY_LOCATION_ID`

The values can be numeric Shopify location IDs or full
`gid://shopify/Location/...` IDs.
