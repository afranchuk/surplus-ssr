# Surplus SSR

This library exposes a relatively simple implementation of SSR using
[Surplus][].

## Usage

The default export of the library is a function that produces a middleware
function for use with server applications (e.g. [express][]).

### `ssr(rootPath, getState, [options])`

Return a middleware function for SSR using the given root path (path to the root
of the content to server) and the given `getState` function, which should return
the current state (more on this later).

Options may be an object with the following keys:
* `clientJS` (`boolean`) - whether to emit client-side javascript (default:
  `true`)
* `pageRoot` (`string`) - the root, relative to `rootPath`, of pages and
  directories to serve (default: `"pages"`)

The middleware function returned is of the typical form (taking two arguments, a
request and a response). It does **not** use the common third argument (a
chaining function), so _technically_ isn't middleware per-se. This could easily
be changed if requested.

The function uses the version of surplus installed in `rootPath` to compile the
surplus expressions, and runs any code within `rootPath` (node modules are
loaded from `rootPath`).

#### `f.middleware`

The function returned by the above also has a property called `middleware` that
acts as true middleware and adds a `respondWithPage` function to the response
object. This function makes less assumptions about the request path to
resource/entrypoint mapping, and is useful if you don't like the default way
that routing is done.  It must be called with the path to the entrypoint as an
argument, where the path is relative to `rootPath`. Any additional arguments are
forwarded to the function exported by the page, if possible. This will run the
code at the given path and appropriately bundle and send the response. For
example:

```javascript
var srv = express();

srv.use(ssr("path/to/root", getState).middleware);

srv.get('/my-path', (req, res) => {
    res.respondWithPage("my-path-page.js", "page-argument");
});

```

### `rootPath` setup

All modules and content needed to render pages should appear within `rootPath`.
For this reason, it's almost always appropriate to initialize a node project
within `rootPath`, and within that project install `s-js` and `surplus`. These
are **required** for the SSR to function properly.

If using the default ssr middleware function, page entry-points are expected in
the `options.pageRoot` directory (default `"pages"`). So this directory must
exist, and should contain the request path layout that you expect. The default
middleware does the following mapping:

```
your_url.com/page -> {options.pageRoot}/page.js | {options.pageRoot}/page/index.js
```

In words: if the page exists as a javascript file (with the `.js` extension) it
is used, otherwise if it exists as a directory and `index.js` exists in the
directory, that is used. Otherwise the request fails.

#### Writing Content

All code that is used for the webpage must use CommonJS/UMD modules. The loader
has not yet been extended to support the experimental node ES6 modules. The code
must also be appropriate to run directly on the client side. I have not used
pre-processing in my workflows, but in theory that should be possible. Importing
modules must be done using `require()` just like other nodejs code.

One important difference right now is that `require()` is **always** relative to
`rootPath`; relative paths from the current file are not yet supported. In my
opinion, this makes some things much clearer. Importing external code from
node_modules works as usual (e.g. `require("d3")`), but, for instance, if you
have a `components` directory in `rootPath`, then importing files from there
should always be done with `require("components/path-to-file")`.

The following global variables will be available, both on the server side and
the client side:
* `S` - the loaded [S.js][] module.
* `Surplus` - the loaded [Surplus][] module.
* `STATE` - the state returned from the `getState` function passed to the
  middleware constructor.
* `isServer` (`boolean`) - Whether the code is running on the server or not
  (client).

This means that your pages don't all need to `require("s-js")` and
`require("surplus")`; you may just use them as if they were already imported.

Pages must export an object, or a function that returns an object, with the
following keys:
* `body` - the body of the page, which must be a DOM element supporting
  `outerHTML`.
* `head` (_optional_) - an array of DOM elements (e.g. `<link />`) that should be
  in the head of the response.

If the page exports a function, that function will be called with any additional
arguments passed to the middleware `respondWithPage` function.

I've used [d3][] for (fairly complex) server-side SVG rendering, and it seems to
work well.

### Client JS

If `options.clientJS` is true (the default), all code for the page is bundled
with the page, and upon load (if the page supports javascript) the content of
the page will be replaced with a 'live' surplus/s-js version. All dependencies
of a page are tracked and bundled together, but no minification is done. If it
is false, no javascript will be bundled, which can save on response size.

I've been able to use websockets and REST APIs without any issue here. It's
fairly simple to create [S.js][] computations around the original server state,
and then update those with data that comes over websockets or from other events.
I've found this approach to work quite well even with high update rates and
fairly large state objects (on the order of tens of thousands of individual
pieces of state, however you may define that...).

## Example Usage

### Server Code (using express)
```javascript
const express = require('express');
const ssr = require('surplus-ssr');
const path = require('path');

const listen_port = 8080;
// Root is in the 'public' folder
const publicRoot = path.join(__dirname, "public");

// Create server
const srv = express();

// Create view state to be used to render the page
// This state provides an object defining the number of overall page loads and
// the load time.
let page_loads = 0;
const getState = () => {
    page_loads++;
    return {
        load_time: new Date().toString(),
        page_loads: page_loads
    };
};

// Render and serve page contents
// Could omit 'middleware', in which case the following srv.get() calls could be
// left out as well, and pages/index.js would work as expected. But pages/getId.js
// wouldn't get arguments in that situation.
srv.use(ssr(publicRoot, getState).middleware);

srv.get('/', (req, res) => { res.respondWithPage("pages/index.js"); });
srv.get('/getId/:id', (req, res) => {
    res.respondWithPage("pages/getId.js", req.params.id);
});

// Run server
const inst = srv.listen(listen_port);
```

### Client/Website Code

#### `public/pages/index.js`

Shows the number of page loads, the server-side page load time, and an updating
time based on the client's clock (if JS is enabled).

```javascript
const now = S.value(new Date());

if (!isServer) {
    // Update displayed time every second on the client
    setInterval(() => {
        now(new Date());
    }, 1000);
}

module.exports = {
    body: S.root(() => (
        <div>
            <h1>Hello, World</h1>
            <p>Number of loads: {STATE.page_loads}</p>
            <p>Loaded at: {STATE.load_time}</p>
            <p>Right now, it is {now()}</p>
        </div>
    ))
};
```

#### `public/pages/getId.js`

Echoes whatever the parameter to the page is.

```javascript
module.exports = (id) => {
    return {
        body: <div><p>Id is {id}</p></div>
    };
};
```

## Improvements
* Partially pre-render pages - it would be useful and powerful to pre-render all
  pages as much as possible, such that when a request comes in the minimal
  amount of processing needs to be done (i.e. things that depend on state are
  rendered).  This will require changes to or a custom implementation of the
  server-side DOM.
* Re-hydrate on the client side rather than replacing all content - with some
  changes to the surplus compiler, it should be possible to use the DOM that was
  rendered on the server side with live [S.js] functions on the client side.
* Rewrite in Typescript - to better match the [S.js] and [Surplus] code.
* Add hooks for pre-processing source pages and minification/bundling of page
  code.

[Surplus]: https://github.com/adamhaile/surplus
[express]: http://expressjs.com/
[S.js]: https://github.com/adamhaile/S
[d3]: https://d3js.org/

