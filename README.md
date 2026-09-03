## Shopify to Easycashier sync application

### EasyCashier authentication

Configure these private Gadget environment variables in each environment:

- `EASYCASHIER_API_BASE_URL`
- `EASYCASHIER_COMPANY_ID`
- `EASYCASHIER_API_USERNAME`
- `EASYCASHIER_API_PASSWORD`

`EASYCASHIER_LOGIN_URL` is optional and defaults to
`https://backoffice.easycashier.se/v1/login`.

API requests send the returned access token as a raw `X-Api-Key`, matching the
existing client behavior. The header name can be overridden with
`EASYCASHIER_API_AUTH_HEADER_NAME` if required.
