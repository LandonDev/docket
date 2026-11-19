import { mount } from './page'

const root = document.getElementById('form')
if (root) void mount(root, location.pathname, (input, init) => fetch(input, { ...init, credentials: 'omit' }))
