# Auth Handler

- Previous ← [Requests](./0-basic-usage.md)
- Next → [Not sure what next?](./something.md)
- ⮐ [Requests Guide](../index.md)

## In This Guide

EmberData is flexible enough to work with any request authentication strategy. This guide will show you how
you might implement some common strategies.

- [JWT Token](#jwt-token)
- [CSRF Token](#csrf-token)
- [Secure Cookie](#secure-cookie)

### JWT Token 

> **Note**
> This example uses [Ember](https://emberjs.com/) for convenience.
>
> `@ember-data/request` works with raw javascript or any framework of your choosing.

Many public APIs require authentication. A common pattern nowadays is the use of an `Authorization` header with a bearer token.

```HTTP
GET /api/companies?fields[company]=name&fields[employee]=name,profileImage&included=ceo&page[size]=10 HTTP/2
Accept: application/vnd.api+json; profile="https://jsonapi.org/profiles/ethanresnick/cursor-pagination"
Authorization: Bearer <token>
```

#### Basic example

In Ember Data we can create our own custom handler to add authentication header to all requests

```js
const ourSecureToken = '<token>'
const AuthHandler = {
 request({ request }, next) {
    const headers = new Headers(request.headers);
    headers.append(
      'Authorization',
      `Bearer ${ourSecureToken}`,
    );

    return next(Object.assign({}, request, { headers }));
  }
}
```

This handler would need to be added to request manager service configuration:

```js
export default class extends RequestManager {
  constructor(args) {
    super(args);

    this.use([AuthHandler, Fetch]);
    this.useCache(CacheHandler);
  }
}
```

This way every request that was made using this request manager will have `Authorization` header added to it.

#### Class based Handler

Handlers can also be defined as classes. This is useful when you need to inject some services into your handler.

Lets imagine we are using [Ember Simple Auth](https://github.com/simplabs/ember-simple-auth) addon to handle authentication. In this case we need to inject `session` service to get the token.

**app/services/auth-handler.js**

```js
import { inject as service } from '@ember/service';

export default class AuthHandler {
  @service session;

  request({ request }, next) {
    const headers = new Headers(request.headers);
    headers.append(
      'Authorization',
      `Bearer ${this.session.accessToken}`,
    );

    return next(Object.assign({}, request, { headers }));
  }
}
```

> **Note**
> This is just a native javascript class, so it is not aware of Ember's dependency injection system.

To use this handler we need to register it in our request manager service, but also we need to tell Ember's dependency injection system to provide context for `@service session;` to work.

**app/services/request-manager.js**

```js
import RequestManager from '@ember-data/request';
import Fetch from '@ember-data/request/fetch';
import { CacheHandler } from '@ember-data/store';
import { getOwner, setOwner } from '@ember/application';
import AuthHandler from './auth-handler';

export default class extends RequestManager {
  constructor(args) {
    super(args);

    const authHandler = new AuthHandler();
    setOwner(authHandler, getOwner(this));

    this.use([authHandler, Fetch]);
    this.useCache(CacheHandler);
  }
}
```

Apart of this little twist with dependency injection, everything else is the same as in previous example.

### CSRF Token

### Simple

The easy way of protecting against Cross Site Request Forgery (CSRF) is to set a static custom header in every HTTP Request (for example `X-CSRF-Protection: static`), check for it on the backend and make sure that CORS is only accepting data from trusted domains.

If you do this, you don't have to generate dynamic CSRF tokens for every request.

More information:

https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS#simple_requests

### Advanced


> **Note**
> This example uses [Ember](https://emberjs.com/) for convenience.
>
> `@ember-data/request` works with raw javascript or any framework of your choosing.

Some APIs require CSRF token to be sent with every request. This token is usually stored in a cookie and needs to be extracted from it.

```HTTP
GET /api/companies?fields[company]=name&fields[employee]=name,profileImage&included=ceo&page[size]=10 HTTP/2
Accept: application/vnd.api+json; profile="https://jsonapi.org/profiles/ethanresnick/cursor-pagination"
X-CSRF-Token: <token>
```

Usually this token is stored in a cookie, so we need to extract it from there. Also this token is usually sent only with `POST`, `PUT`, `PATCH` and `DELETE` requests. Let's create a handler that will do just that.

```js
const MUTATION_OPS = new Set(['createRecord', 'updateRecord', 'deleteRecord']);

const AuthHandler = {
  request({ request }, next) {
    if (MUTATION_OPS.has(request.op)) {
      const headers = new Headers(request.headers);
      headers.append(
        'X-CSRF-Token',
        document.cookie.match(/csrfToken=([^;]+)/)[1],
      );
      return next(Object.assign({}, request, { headers }));
    }

    return next(request);
  }
}
```

This handler would need to be added to request manager service configuration:

```js
export default class extends RequestManager {
  constructor(args) {
    super(args);

    this.use([AuthHandler, Fetch]);
    this.useCache(CacheHandler);
  }
}
```

This way every request that was made using this request manager will have `X-CSRF-Token` header added to it when needed.

### Secure Cookie

Secure cookies are automatically managed by the browser, so we don't
need to do anything special to send them with our requests when using
native fetch (as for instance the provided `Fetch` handler does).
We just need to make sure that we are requesting our API from the same
domain that it is served from.

There are a few scenarios where you may need to manage the cookie
yourself, in these cases you could write a handler and take the same
approach as the JWT Token example above. For instance, using a WebView
to deploy a mobile or desktop app or if you are using a custom fetch
library that doesn't automatically send cookies (potentially for something like SSR).

---

- Previous ← [Requests](./0-basic-usage.md)
- Next → [Not sure what next?](./something.md)
- ⮐ [Requests Guide](../index.md)
