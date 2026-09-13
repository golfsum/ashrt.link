// Remembers the guest links made in this browser so signup can claim them.
//
// Tokens live in localStorage only until the account is created, then they are
// cleared: once a link belongs to an account, the token is redundant and
// keeping it around is one more copy of a credential than we need.

window.GuestLinks = {
  KEY: 'ashrt_guest_links',

  all() {
    try {
      const raw = JSON.parse(localStorage.getItem(this.KEY) || '[]')
      return Array.isArray(raw) ? raw.filter((r) => r && r.token) : []
    } catch {
      return []
    }
  },

  add(link) {
    if (!link?.manageToken) return
    try {
      const list = this.all().filter((r) => r.slug !== link.slug)
      list.unshift({ slug: link.slug, token: link.manageToken, url: link.url, at: Date.now() })
      localStorage.setItem(this.KEY, JSON.stringify(list.slice(0, 20)))
    } catch {
      // Private browsing and blocked storage are fine: the link still works,
      // the user just will not be offered it automatically at signup.
    }
  },

  tokens() {
    return this.all().map((r) => r.token)
  },

  clear() {
    try {
      localStorage.removeItem(this.KEY)
    } catch {
      /* nothing to do */
    }
  },
}
