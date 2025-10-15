# General

Avoid commenting unless necessary. Prefer functional programming, use gamla
functions when applicable. Constant naming should be in normal case, e.g.
`const myConstant = 1;`

Avoid `let`

Factor out logic, preferrable to module level functions.

Avoid dynamic imports, use static imports instead.

Place imports at the top of the file.

Don't use `export default`, prefer `export const`

# React stuff

1. Keep react component style as module level constants.
1. if css json objects are too big factor them out to module level constants,
   but if they are small it's fine to inline.
1. Prefer to keep the component body relatively small and move logic outside to
   module level. Use currying if needed.
1. use toast.promise for async operations that need to show a toast.

# Deno stuff

1. This is a deno project. So deps are in deno.json, there is no package.json.
