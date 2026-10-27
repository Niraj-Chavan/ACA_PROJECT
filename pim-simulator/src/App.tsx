import { useState, useEffect } from 'react'
import { StoreProvider } from './state/hooks'
import { Simulator } from './pages/Simulator'
import { Experiments } from './pages/Experiments'
import { Results } from './pages/Results'
import { Learn } from './pages/Learn'
import { About } from './pages/About'

type Page = 'simulator' | 'experiments' | 'results' | 'learn' | 'about'

const NAV: { id: Page; label: string }[] = [
  { id: 'simulator', label: 'Simulator' },
  { id: 'experiments', label: 'Experiments' },
  { id: 'results', label: 'Results' },
  { id: 'learn', label: 'Learn' },
  { id: 'about', label: 'About' },
]

function Shell() {
  const [page, setPage] = useState<Page>('simulator')
  const [dark, setDark] = useState(true)
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }, [dark])

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="logo">▚</span>
          <div>
            <h1>CPU ⇄ PIM Simulator</h1>
            <p>Processing-in-Memory performance & energy explorer</p>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <button key={n.id} className={`nav-btn ${page === n.id ? 'active' : ''}`} onClick={() => setPage(n.id)}>
              {n.label}
            </button>
          ))}
        </nav>
        <button className="btn theme" onClick={() => setDark(!dark)} title="Toggle theme">
          {dark ? '☀ light' : '☾ dark'}
        </button>
      </header>
      <main>
        {page === 'simulator' && <Simulator />}
        {page === 'experiments' && <Experiments />}
        {page === 'results' && <Results />}
        {page === 'learn' && <Learn />}
        {page === 'about' && <About />}
      </main>
      <footer>
        <span>Advanced Computer Architecture · PIM simulator · first-order analytical model</span>
      </footer>
    </div>
  )
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  )
}
