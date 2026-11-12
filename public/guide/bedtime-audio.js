// This guide is local reading/practice only: no storage, account reads or media requests.
const sections = [...document.querySelectorAll('[data-step]')]
const links = [...document.querySelectorAll('[data-step-link]')]
const previous = document.getElementById('previous')
const next = document.getElementById('next')
const progress = document.getElementById('step-progress')
let activeStep = 0

function showStep(index, moveFocus = true) {
  activeStep = Math.max(0, Math.min(sections.length - 1, index))
  sections.forEach((section, position) => {
    section.hidden = position !== activeStep
  })
  links.forEach((link, position) => {
    if (position === activeStep) link.setAttribute('aria-current', 'step')
    else link.removeAttribute('aria-current')
  })
  previous.disabled = activeStep === 0
  next.disabled = activeStep === sections.length - 1
  progress.textContent = `Step ${activeStep + 1} of ${sections.length}`
  if (moveFocus) sections[activeStep].querySelector('h2').focus()
}
links.forEach((link) => {
  link.addEventListener('click', (event) => {
    event.preventDefault()
    showStep(Number(link.dataset.stepLink))
  })
})
previous.addEventListener('click', () => showStep(activeStep - 1))
next.addEventListener('click', () => showStep(activeStep + 1))
document.querySelector('.step-actions').hidden = false
showStep(0, false)

const examples = {
  waiting: 'Finish any steps in Shortcuts or Endel, then return to Sleepypod. Do not start a second copy while the result is pending.',
  unknown: 'Check Endel and the speakers first. Audio may already be playing. Review the unknown result before choosing another Start; the request has not been resent.',
  quiet: 'Someone requested quiet time, so a new Start is withheld. Audio already playing still needs an explicit Pause.',
  pause: 'Check that the audio stopped. This Shortcut return does not confirm it stopped. Mark your own observation separately in Sleepypod.',
}
document.getElementById('example-status').addEventListener('change', (event) => {
  document.getElementById('example-response').textContent = examples[event.target.value] ?? examples.waiting
})
document.querySelector('.example').hidden = false
