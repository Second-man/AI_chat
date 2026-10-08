// Mocked browser acceptance: never calls Tavily or an LLM.
const assert = require('node:assert/strict')
const { chromium } = require(process.env.ECHOMATE_PLAYWRIGHT || 'playwright')
;(async () => {
  const browser = await chromium.launch({headless:true,channel:'msedge'})
  try {
    for (const overlay of [false,true]) {
      const page = await browser.newPage({viewport:overlay ? {width:480,height:520}:{width:1180,height:780}})
      const searches = [], analyses = []
      let fail = true
      await page.route('http://127.0.0.1:8787/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname
        let data = [], status = 200
        if (path === '/settings') data = {api_key_configured:true, tavily_key_configured:true, base_url:'https://example.com',chat_model:'test',embedding_model:'test',user_name:'',user_notes:''}
        if (path === '/contacts') data = [{id:1,name:'虚构联系人',relationship:'朋友'}]
        if (path === '/messages') data = {id:2}
        if (path === '/web-search') {
          searches.push(request.postDataJSON());
          if(fail) {status=504;data={detail:'搜索超过 15 秒'}}
          else data={search_id:'mock',retrieved_at:'2026-10-08T00:00:00Z',sources:[]}
        }
        if (path === '/analyze') {analyses.push(request.postDataJSON());data={answer:'模拟回复 [W1]',citations:[],web_sources:[{id:'W1',title:'测试来源',url:'https://example.com',excerpt:'测试摘要'}],web_retrieved_at:'2026-10-08T00:00:00Z'}}
        await route.fulfill({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(data)})
      })
      await page.goto('http://127.0.0.1:5173/'+(overlay?'overlay.html':''))
      await page.getByText('虚构联系人',{exact:true}).first().waitFor()
      const toggle=page.getByLabel('本次联网检索')
      assert.equal(await toggle.isChecked(),false)
      await page.locator(overlay?'.overlay-composer':'#message').fill('虚构聊天原文')
      await toggle.check()
      const query=page.getByLabel('确认搜索关键词')
      assert.equal(await query.inputValue(),'')
      await query.fill('公开梗解释')
      await page.getByRole('button',{name:/查看发送预览/}).click()
      assert.equal(searches.length,0)
      await page.getByRole('button',{name:'取消',exact:true}).click()
      assert.equal(searches.length,0)
      assert.equal(await toggle.isChecked(),false)
      await toggle.check(); await query.fill('公开梗解释')
      await page.getByRole('button',{name:/查看发送预览/}).click()
      await page.getByRole('button',{name:'确认 / 重试'}).click()
      await page.getByRole('alert').waitFor()
      assert.equal(analyses.length,0)
      assert.deepEqual(searches[0],{query:'公开梗解释'})
      fail=false
      await page.getByRole('button',{name:'确认 / 重试'}).click()
      await page.getByText('模拟回复 [W1]',{exact:true}).waitFor()
      assert.equal(analyses[0].web_search_id,'mock')
      assert.equal(await toggle.isChecked(),false)
      assert.equal(await page.getByRole('link',{name:'[W1] 测试来源'}).count(),1)
      const bottom=await page.locator(overlay?'.overlay-footer':'.composer-footer').boundingBox()
      if(overlay) assert.ok(bottom.y+bottom.height<=521,'overlay footer overflow')
      await page.close()
      console.log((overlay?'Overlay':'Desktop')+' search consent, cancel, failure, retry, reset and sources: PASS')
    }
  } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1})
