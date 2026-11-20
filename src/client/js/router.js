/* 剧场 Studio · hash 路由 __ROUTER（骨架文件，agent 勿改） */
(function (global) {
  "use strict";

  /* 路由表：pattern → {view, ep:true} */
  const ROUTES = [
    { re: /^#?\/?$/, view: "Home" },
    { re: /^#\/login$/, view: "Login" },
    { re: /^#\/home$/, view: "Home" },
    { re: /^#\/ep\/([^/]+)$/, view: "Flow", ep: true },
    { re: /^#\/ep\/([^/]+)\/flow$/, view: "Flow", ep: true },
    { re: /^#\/ep\/([^/]+)\/shoot$/, view: "Shoot", ep: true },
    { re: /^#\/ep\/([^/]+)\/assets$/, view: "Assets", ep: true },
    { re: /^#\/ep\/([^/]+)\/deliver$/, view: "Deliver", ep: true },
    { re: /^#\/ep\/([^/]+)\/costs$/, view: "Costs", ep: true },
    { re: /^#\/review$/, view: "Review" },
    { re: /^#\/admin$/, view: "Admin" },
    { re: /^#\/settings$/, view: "Settings" }
  ];

  function parse(hash) {
    const h = hash || "#/home";
    for (const r of ROUTES) {
      const m = h.match(r.re);
      if (m) return { view: r.view, epId: r.ep ? decodeURIComponent(m[1]) : null };
    }
    return { view: "Home", epId: null, notFound: true };
  }

  const listeners = [];
  const ROUTER = {
    current: parse(global.location.hash),
    start() {
      global.addEventListener("hashchange", () => {
        ROUTER.current = parse(global.location.hash);
        listeners.forEach(fn => fn(ROUTER.current));
      });
    },
    onChange(fn) { listeners.push(fn); },
    go(hash) {
      if (global.location.hash === hash) {
        ROUTER.current = parse(hash);
        listeners.forEach(fn => fn(ROUTER.current));
      } else global.location.hash = hash;
    },
    ep(tab, id) { return "#/ep/" + encodeURIComponent(id || ROUTER.current.epId || "") + "/" + tab; }
  };
  global.__ROUTER = ROUTER;
})(window);
