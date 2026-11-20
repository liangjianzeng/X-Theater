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
  // 路由状态响应化：同一 reactive 对象就地更新，依赖它的 computed（如副驾上下文芯片）随路由重算
  const Vue = global.Vue;
  const ROUTER = {
    current: (Vue && Vue.reactive ? Vue.reactive(parse(global.location.hash)) : parse(global.location.hash)),
    start() {
      global.addEventListener("hashchange", () => {
        apply(parse(global.location.hash));
        listeners.forEach(fn => fn(ROUTER.current));
      });
    },
    onChange(fn) { listeners.push(fn); },
    go(hash) {
      if (global.location.hash === hash) {
        apply(parse(hash));
        listeners.forEach(fn => fn(ROUTER.current));
      } else global.location.hash = hash;
    },
    ep(tab, id) { return "#/ep/" + encodeURIComponent(id || ROUTER.current.epId || "") + "/" + tab; }
  };
  function apply(next) {
    Object.keys(ROUTER.current).forEach(k => { if (!(k in next)) ROUTER.current[k] = undefined; });
    Object.keys(next).forEach(k => { ROUTER.current[k] = next[k]; });
  }
  global.__ROUTER = ROUTER;
})(window);
