// Library version — exposed as window.API_UTILS_VERSION for /healthz-style
// reporting. Bump on every behavioural change. Services pin their vendor
// `git clone` to a tag, then bump deliberately. The api.js file also
// hardcodes the version in its IIFE; both must match.

window.API_UTILS_VERSION = '0.1.0';
