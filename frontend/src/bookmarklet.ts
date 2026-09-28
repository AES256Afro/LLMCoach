/** The bookmarklet for this LLMCoach: opens /add with the current page's address and title. */
export function bookmarklet(origin = window.location.origin): string {
  const open = `window.open('${origin}/add?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title),'llmcoach-add','width=560,height=620')`
  return `javascript:(()=>{${open}})()`
}
