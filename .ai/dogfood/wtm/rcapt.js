var rcapt_reload = 0;
var chase = 0;
var langs = new Array();
var timer = null;
langs["ko_KR"] = [
["note","해당 영수증은 가상으로 제작된 것으로 실제 영수증 사진이 아닙니다."],
["code","정답을 입력해주세요."],
["typeWords","자동입력 방지문자를 입력해 주세요!"]
];
langs["en_US"] = [
["note","This receipt is made virtually. Not a real receipt."],
["code","Please enter the answer."],
["typeWords","Please enter the Code."]
];
langs["zh-Hans_CN"] = [
["note","该收据是假造的. 不是实际收据照片."],
["code","请输入你的答案。"],
["typeWords","请你输入验证码。"]
];
langs["zh-Hant_TW"] = [
["note","該收據是假造的. 不是實際收據照片."],
["code","請輸入你的答案。"],
["typeWords","請你輸入驗證碼。"]
];
langs["fr_FR"] = [
["note","This receipt is made virtually. Not a real receipt."],
["code","Please enter the answer."],
["typeWords","Please enter the answer."]
];
langs["ja_JP"] = [
["note","This receipt is made virtually. Not a real receipt."],
["code","Please enter the answer."],
["typeWords","Please enter the answer."]
];

// console 미 존재시에 문제 발생 방지
var console = console || {
    "log": function(stuff) {}
};

function getXmlHttp() {
	var a;
	try {
		if (window.XMLHttpRequest) {
			// code for modern browsers
			return new XMLHttpRequest();
		} else {
			// code for old IE browsers
			return new ActiveXObject("Microsoft.XMLHTTP");
		}
	} catch (c) {
		a = false
	}
	return a
}

function insertImage(response) {
	// console.log("insertImage func: [" + response + "]");
	
	questionResponse = JSON.parse(response);
	
	var receiptData = questionResponse["receiptData"];
	var img = receiptData["image"];
	var question = receiptData["question"];
	
	rcapt$("captchaimg").src = img;
	rcapt$("captcha_info").innerHTML = question;
}

function createJsonRequest(requestUrl) {
	try {
		var jsonpCall = document.createElement('script');
		jsonpCall.type = "text/javascript";
		jsonpCall.src = requestUrl;
		document.getElementsByTagName('head')[0].appendChild(jsonpCall);
	}catch (e) {}
}
var useJson = false;
function getAjaxResultForRcaptcha(requestUrl, contentType) {
	try {
		var requestObject = getXmlHttp();
		requestObject.open("GET", requestUrl, false);
		requestObject.withCredentials = true;
		requestObject.onreadystatechange = function() {
			if (requestObject.readyState == 4) {
				// console.log(requestObject.responseText);
				
				if (contentType == "html") {
					// console.log("insert html: " + requestObject.responseText);
					insertRcaptUi(requestObject.responseText);
				}
				
				if (contentType == "img") {
					// console.log("img: " + requestObject.responseText);
					insertImage(requestObject.responseText);
				}
			}
		};
		requestObject.send(null);
	} catch (b) {
		useJson = true;
		if (contentType == "html") {
			createJsonRequest(requestUrl+"&type=jsonp&callBack=ab15bebf730be4310ad3d27d0eeb2055a");
		} else {
			createJsonRequest(requestUrl+"&type=jsonp&callBack=a87cd373bbbe84952980f4ac544fb51fa");
		}
		if (window.bridgeGotTime) {
			throw b
		}
	}
}
var viewObjMap;
if (!document.querySelectorAll) {
  document.querySelectorAll = function (selectors) {
    var style = document.createElement('style'), elements = [], element;
    document.documentElement.firstChild.appendChild(style);
    document._qsa = [];

    style.styleSheet.cssText = selectors + '{x-qsa:expression(document._qsa && document._qsa.push(this))}';
    window.scrollBy(0, 0);
    style.parentNode.removeChild(style);

    while (document._qsa.length) {
      element = document._qsa.shift();
      element.style.removeAttribute('x-qsa');
      elements.push(element);
    }
    document._qsa = null;
    return elements;
  };
}

if (!document.querySelector) {
  document.querySelector = function (selectors) {
    var elements = document.querySelectorAll(selectors);
    return (elements.length) ? elements[0] : null;
  };
}
function setLanguage(currentLanguage) {
	var changeNodeList = document.querySelectorAll('[data-detect]');
	viewObjMap = new mapObj(langs[currentLanguage]);
	for (var i=0;i<changeNodeList.length;i++ ) {
		handleEachLang(changeNodeList[i]);
	}
}

function handleEachLang(obj) {
	if (obj.tagName=="INPUT") {
		obj.setAttribute("placeholder",viewObjMap.get(obj.getAttribute('data-detect')))
		obj.setAttribute("title",viewObjMap.get(obj.getAttribute('data-detect')))
	} else {
		obj.innerHTML = viewObjMap.get(obj.getAttribute('data-detect'));
	}
}

function rcapt$(id) {
	return document.getElementById(id);
}

function insertRcaptUi(rcapt_html) {

	try {
		rcapt$('rcapt').innerHTML = rcapt_html;

	} catch (e) {
		var new_rcapt = document.createElement('div');
		new_rcapt.innerHTML = rcapt_html;
		var current_rcapt = rcapt$('rcapt');
		current_rcapt.appendChild(new_rcapt);
	}
	setLanguage('en_US');
	try {
		if (loadFinish != undefined) {
			loadFinish();
		}
	} catch(e) {}
}
function mapObj (initArray) {
	var elementMap;
	var isMapAvailable=false;
	if (typeof Map!='undefined') {
		isMapAvailable = true;
	}
	this.getMap=function(){
		return this.elementMap;
	}	
	this.init=function(initVal){
		if (this.isMapAvailable) {
			this.elementMap = new Map();
		} else {
			this.elementMap = new Array();
		}
		for (var key in initVal) {
			this.set(initVal[key][0],initVal[key][1]);
		}
	}
	this.get=function(findVal){
		if (this.isMapAvailable) {
			return this.elementMap.get(findVal);
		} else {
			for(var prop in this.elementMap) {
				if (prop == findVal) {
					return this.elementMap[prop];
				}
			}
			return "";
		}
	}
	this.set=function(keyStr,valStr){
		if (this.isMapAvailable) {
			this.elementMap.set(keyStr,valStr);
		} else {
			this.elementMap[keyStr] = valStr;
		}
	}
	this.init(initArray);
}
function insertRcaptCss(rcapt_style) {
	var cssId = 'rcapt_css';
	
    var head  = document.getElementsByTagName('head')[0];
    var link  = document.createElement('link');
    link.id   = cssId;
    link.rel  = 'stylesheet';
    link.type = 'text/css';
    link.href = 'https://rcaptcha.nid.naver.com/rcaptCss?key=8HF3iY7R19Nh3B';
    link.media = 'all';
    head.appendChild(link);
	    
    // console.log("add link:" + link);
}

function rcapt_submit() {
	var value = rcapt$('captcha').value;
	
	if (value != "") {
		rcapt$('rcapt_submit_val').value = value;
		rcapt$('guide_captcha_area').innerHTML = "'" + value + "' 를 입력하였습니다.";
	}

	try {
		var c = "https://rcaptcha.nid.naver.com/verify?key=8HF3iY7R19Nh3B&svc=nid&answer="+value;
		var a = getXmlHttp();
		a.open("GET", c);
		a.onreadystatechange = function() {
			if (a.readyState == 4) {
				// console.log(a.responseText);
				// console.log("insert html: " + a.responseText);
				// insertRcaptUi(a.responseText);
				try {
					rcapt$('rcapt_submit_result').innerHTML = a.responseText;
				} catch (e) {
					var new_rcapt = document.createElement('div');
					new_rcapt.innerHTML = a.responseText;
					var current_rcapt = rcapt$('rcapt');
					current_rcapt.appendChild(new_rcapt);
				}
			}
		}
		a.send(null);
	} catch(b) {
		if (window.bridgeGotTime) {
			throw b
		}
	}
}

function ab15bebf730be4310ad3d27d0eeb2055a(contents) {
	insertRcaptUi(contents);
}

function a87cd373bbbe84952980f4ac544fb51fa(contents) {
	insertImage(JSON.stringify(contents));
}

function re_capt() {
	rcapt_reload++;
	getAjaxResultForRcaptcha("https://rcaptcha.nid.naver.com/question?key=8HF3iY7R19Nh3B&svc=nid&reload=" + rcapt_reload, "img");
}

function init_js_captcha() {
    chase = 3;
    var asdf = new homz.Koop({siteKey:"0f79c7078f72eea174b2b35752b288599ba7030c7698d2fd4aa28c012124f0839956ebcf774bd764fb362958"});
    chase = 4;

    asdf.f(function(tokenId) {
        chase = 5;
        try {
            var requestObject = getXmlHttp();
            requestObject.open("GET", "https://rcaptcha.nid.naver.com/verifyJs?key=8HF3iY7R19Nh3B&svc=nid&tokenId=" + tokenId, false);
            requestObject.withCredentials = true;
            requestObject.onreadystatechange = function() {
                if (requestObject.readyState == 4) {
                    clearTimeout(timer)
                }
            };
            requestObject.send(null);
            chase = 6;
        } catch (b) {
            chase = -2
            console.log("error")
        }
    });
}

function apply_js_captcha() {
    timer = setTimeout(function () {
        var requestObject = getXmlHttp();
        requestObject.open("GET", "https://rcaptcha.nid.naver.com/chase_logging?key=8HF3iY7R19Nh3B&svc=nid&chase=" + chase, false);
        requestObject.withCredentials = true;

        requestObject.send(null);
    }, 5000)
    chase = 1;
    try {
        var script = document.createElement('script');
        script.type = "text/javascript";
        script.src = "https://ncpt.naver.com/static/ncaptcha-api.js?ncaptcha-sitekey=0f79c7078f72eea174b2b35752b288599ba7030c7698d2fd4aa28c012124f0839956ebcf774bd764fb362958&ncaptcha-onload=init_js_captcha";

        document.body.appendChild(script);
        chase = 2;
    } catch(e) {
        chase = -1;
        console.log("apply_js_captcha error");
        console.log(e);
    }
}

getAjaxResultForRcaptcha("https://rcaptcha.nid.naver.com/rcaptUi?key=8HF3iY7R19Nh3B", "html");
insertRcaptCss();
getAjaxResultForRcaptcha("https://rcaptcha.nid.naver.com/question?key=8HF3iY7R19Nh3B&svc=nid", "img");
apply_js_captcha();