const dom = require('domino');
const vm = require('vm');
const fs = require('fs');
const path = require("path");

const cache = {};
var compiler = null;
// Compile a file with the surplus compiler (set by serve())
const compile = (file) => {
    if (!(file in cache)) {
        const data = fs.readFileSync(file, 'utf8');
        try {
            cache[file] = compiler.compile(data);
        }
        catch (err) {
            console.error("Error occurred when compiling " + file + ":");
            console.error(err);
            throw err;
        }
    }
    return cache[file];
};

// Initial global context to be used when executing scripts
const global = {
    document: dom.createDocument()
};

// 'Node' is required by the surplus runtime (it uses `instanceof Node`), and other types should be present too.
for (let k in dom.impl) {
    global[k] = dom.impl[k];
}

// Defer bindings in a string template literal
const defer = (strings, ...keys) => (o) => {
    const result = [strings[0]];
    keys.forEach((key, i) => {
        result.push(o[key], strings[i+1]);
    });
    return result.join('');
};

// Template for the head of the HTML response
const headtmpl = defer`
    <meta charset="UTF-8">
    ${'extrahead'}
`;

// Template for the javascript source to be sent with client responses.
const jstmpl = defer`
    <script type="text/javascript">
        const STATE = ${'state'};

        let require = null;
        let S = null;
        //let SArray = null;
        let Surplus = null;
        const isServer = false;
        const modules = ${'modules'};
        const loaded = {};
        require = (n) => {
            if (!(n in loaded)) {
                loaded[n] = modules[n]();
            }
            return loaded[n];
        };
        S = require('s-js');
        Surplus = require('surplus');

        function init() {
            const root = require("__ROOT__").body;
            document.body.replaceChild(root, document.body.firstChild);
        }
    </script>
`;

const serve = (rootPath, getState, options) => {
    options = options || {};
    if (typeof options.clientJS != "boolean")
        options.clientJS = true;
    if (typeof options.pageRoot != "string")
        options.pageRoot = "pages";

    // Find a node module in rootPath
    const findNodeModule = (n) => {
        const base = path.join(rootPath, "node_modules", n);

        let pkg = null;
        if (fs.existsSync(path.join(base, "package.json"))) {
            pkg = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8"));
            if (pkg.main) return path.join(base, pkg.main);
        }

        if (fs.existsSync(path.join(base, "index.js"))) return path.join(base, "index.js");
        else if (pkg && pkg.module) {
            return path.join(base, pkg.module);
        }

        throw "Module not found: " + n;
    };

    // Use the surplus version installed in rootPath
    if (compiler === null) {
        compiler = require(findNodeModule("surplus/compiler"));
    }

    let scriptCtx = null;
    const rcache = {};

    // Load a file or module in the rootPath.
    const load = (n) => {
        if (!(n in rcache)) {
            let contents = null;
            let p = null;
            let usesState = false;
            // Check if the file exists, relative to the root path and with a '.js' extension
            if (fs.existsSync(path.join(rootPath, n) + ".js")) {
                p = path.join(rootPath, n) + ".js";
                contents = compile(p);
                usesState = true;
            }
            // Check if the file exists, relative to the root path
            else if (fs.existsSync(path.join(rootPath, n))) {
                p = path.join(rootPath, n);
                contents = compile(p);
                usesState = true;
            }
            // Check if the module exists
            else {
                p = findNodeModule(n);
                contents = fs.readFileSync(p, "utf8");
            }

            // Cache the contents of the loaded code
            rcache[n] = {
                code: contents
            };

            // Run the code from filename with the given context. If an error occurs, print out some useful information.
            const runCode = (code, ctx, filename) => {
                try {
                    vm.runInNewContext(code, ctx, { filename: filename });
                }
                catch (err) {
                    console.error("Error running compiled code for " + filename + ":");
                    console.error(code);
                    console.error(err);
                    throw err;
                }
            };

            // Get the module exports from executing the code of the cache entry, given the request and state.
            rcache[n].result = (req, s) => {
                // Store a local cache for the request
                if (!req._cache) req._cache = {};

                if (!(n in req._cache)) {
                    const e = {};

                    // Create a context with module.exports and exports in the global scope
                    const ctx = Object.assign({ module: {exports: e}, exports: e }, global);
                    let deps = null;

                    if (!rcache[n].deps) {
                        deps = {};
                        // Create a require implementation in the global context that marks dependencies
                        ctx.require = (n) => {
                            deps[n] = true;
                            return load(n).result(req, s);
                        };
                    }
                    else {
                        // We already know dependencies, so require() doesn't need to mark them.
                        ctx.require = (n) => load(n).result(req, s);
                    }

                    // If the code is (possibly) stateful, it should always be re-executed
                    if (usesState) {
                        // Add script context for stateful/user code
                        Object.assign(ctx, scriptCtx(req, s));
                        runCode(rcache[n].code, ctx, p);
                    }
                    else {
                        // Non-stateful code execution results may be cached
                        if (!rcache[n]._cacheResult) {
                            runCode(rcache[n].code, ctx, p);
                            rcache[n]._cacheResult = ctx.module.exports;
                        }
                        ctx.module.exports = rcache[n]._cacheResult;
                    }

                    // The dependencies should be stored on first execution
                    // XXX: The dependency recording assumes they are static:
                    // the set required on first execution must be a superset
                    // of those required in all following executions.
                    if (!rcache[n].deps) {
                        rcache[n].deps = Object.keys(deps);
                    }

                    req._cache[n] = ctx.module.exports;
                }

                return req._cache[n];
            };
        }

        return rcache[n];
    };

    // Recursively get all dependencies of the given entry point, and collapse
    // them into a string representation of a dictionary mapping names to code.
    const flattenModules = (root) => {
        // Always include s-js and surplus
        const used = {'s-js': true, 'surplus': true};
        const remaining = [root];
        while (remaining.length > 0) {
            let n = remaining.pop();
            used[n] = true;
            remaining.push(...rcache[n].deps);
        }
        return '{' + Object.keys(used).map(n => {
            let name = n;
            if (n === root) name = "__ROOT__";
            return `"${name}": (function() {
                const exports = {};
                const module = {exports: exports};
                (function() {
                    ${rcache[n].code}
                })();
                return module.exports;
            }),`;
        }).join('') + '}';
    };

    // Return script(user-code)-specific global context.
    // A similar context with appropriate values is sent when clientJS is true.
    scriptCtx = (req, s) => {
        return {
            // Always include S
            S: load('s-js').result(req, s),
            // Always include Surplus
            Surplus: load('surplus').result(req, s),
            // Expose state in a global STATE variable
            STATE: s,
            // Allow code to differentiate between running on the server or client.
            isServer: true
        };
    };

    const respondWithPage = (req, res, path, args) => {
        args = args || [];
        // Get the current state
        const state = getState();
        // Load the requested file in the cache
        const r = load(path);
        // Get the exports of page
        let ret = r.result(req, state);
        // If the page exports a function, run it to get the response object
        if (typeof ret == "function") ret = ret(...args);

        // Get the body of the page
        let body = ret.body;

        // Get the extra head content of the page, if any
        let extraHead = "";
        if ("head" in ret) {
            extraHead = ret.head.map(s => s.outerHTML).join('');
        }
        // If clientJS is enabled, package and send the JS needed to run the
        // page in the client.
        if (options.clientJS) {
            extraHead += jstmpl({
                modules: flattenModules(path),
                state: JSON.stringify(state)
            });
        }
        // Body should be an HTML element; get the outerHTML
        body = body.outerHTML;

        //Create the head content
        const head = headtmpl({
            extrahead: extraHead
        });

        // Send the HTML response
        res.end(`
            <!DOCTYPE html>
            <html>
                <head>${head}</head>
                <body ${options.clientJS ? 'onload="init()"' : ''}>${body}</body>
            </html>
        `);
    };

    // Make a middleware function to handle requests and responses. 
    // It will use pageRoot to find page entry points, and will route requests
    // to javascript files (ending in .js) or index.js within directories.
    //
    // website.com/blah -> {pageRoot}/blah.js or {pageRoot}/blah/index.js
    //
    const respond = (req, res) => {
        // Get the path of the page relative to rootPath
        let relpath = path.join(options.pageRoot, req.path);
        // Get the full path of the page
        let fullpath = path.join(rootPath, relpath);

        // If a directory is provided and index.js exists within it, use that file
        if (fs.existsSync(fullpath) && fs.statSync(fullpath).isDirectory() && fs.existsSync(path.join(fullpath, "index.js"))) relpath = path.join(relpath, "index");

        respondWithPage(req, res, relpath);
    };

    // Expose the simpler middleware that adds the respondWithPage function
    respond.middleware = (req, res, next) => {
        res.respondWithPage = (relpath, ...args) => respondWithPage(req, res, relpath, args);
        next();
    };

    return respond;
};

module.exports = serve;

