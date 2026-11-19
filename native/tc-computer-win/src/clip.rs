//! What `paste` puts on the Windows clipboard (docs/computer-protocol.md §5.3,
//! §29.4): the `HTML Format` with its byte-offset header, HTML rendered from
//! markdown, and the plain text of an HTML fragment. Platform-free.

/// Windows' `HTML Format` (CF_HTML): a header of byte offsets into the UTF-8 that follows, then the
/// document with the fragment between its markers.
pub fn cf_html(fragment: &str) -> Vec<u8> {
    const HEAD: &str = "Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n";
    let pre = "<html><body>\r\n<!--StartFragment-->";
    let post = "<!--EndFragment-->\r\n</body></html>";
    let start_html = HEAD.len();
    let start_frag = start_html + pre.len();
    let end_frag = start_frag + fragment.len();
    let end_html = end_frag + post.len();
    let head = format!("Version:0.9\r\nStartHTML:{start_html:010}\r\nEndHTML:{end_html:010}\r\nStartFragment:{start_frag:010}\r\nEndFragment:{end_frag:010}\r\n");
    debug_assert_eq!(head.len(), HEAD.len());
    format!("{head}{pre}{fragment}{post}").into_bytes()
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Inline markdown: `code`, **bold**, *italic* or _italic_, [text](url).
fn inline(s: &str) -> String {
    let mut out = String::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    let find = |from: usize, pat: &[char]| -> Option<usize> { (from..chars.len()).find(|&j| chars[j..].starts_with(pat)) };
    while i < chars.len() {
        let c = chars[i];
        if c == '`' {
            if let Some(end) = find(i + 1, &['`']) {
                out += &format!("<code>{}</code>", escape(&chars[i + 1..end].iter().collect::<String>()));
                i = end + 1;
                continue;
            }
        }
        if chars[i..].starts_with(&['*', '*']) {
            if let Some(end) = find(i + 2, &['*', '*']) {
                out += &format!("<strong>{}</strong>", inline(&chars[i + 2..end].iter().collect::<String>()));
                i = end + 2;
                continue;
            }
        }
        if c == '*' || c == '_' {
            if let Some(end) = find(i + 1, &[c]).filter(|&e| e > i + 1) {
                out += &format!("<em>{}</em>", inline(&chars[i + 1..end].iter().collect::<String>()));
                i = end + 1;
                continue;
            }
        }
        if c == '[' {
            if let Some(mid) = find(i + 1, &[']', '(']) {
                if let Some(end) = find(mid + 2, &[')']) {
                    let text: String = chars[i + 1..mid].iter().collect();
                    let url: String = chars[mid + 2..end].iter().collect();
                    out += &format!("<a href=\"{}\">{}</a>", escape(&url), inline(&text));
                    i = end + 1;
                    continue;
                }
            }
        }
        out += &escape(&c.to_string());
        i += 1;
    }
    out
}

/// Markdown as HTML: headings, paragraphs, bullet and numbered lists, fenced code, and the inline marks.
/// Enough for what a model pastes into a mail or a document; anything else stays as its text.
pub fn markdown_html(md: &str) -> String {
    let mut out = String::new();
    let mut para: Vec<String> = Vec::new();
    let mut list: Option<&str> = None;
    let mut code: Option<Vec<String>> = None;
    let flush = |out: &mut String, para: &mut Vec<String>, list: &mut Option<&str>| {
        if !para.is_empty() {
            *out += &format!("<p>{}</p>", para.iter().map(|l| inline(l)).collect::<Vec<_>>().join("<br>"));
            para.clear();
        }
        if let Some(tag) = list.take() {
            *out += &format!("</{tag}>");
        }
    };
    for line in md.lines() {
        if let Some(block) = code.as_mut() {
            if line.trim_start().starts_with("```") {
                out += &format!("<pre><code>{}</code></pre>", escape(&block.join("\n")));
                code = None;
            } else {
                block.push(line.to_string());
            }
            continue;
        }
        let t = line.trim_start();
        if t.starts_with("```") {
            flush(&mut out, &mut para, &mut list);
            code = Some(Vec::new());
            continue;
        }
        if t.is_empty() {
            flush(&mut out, &mut para, &mut list);
            continue;
        }
        let hashes = t.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&hashes) && t[hashes..].starts_with(' ') {
            flush(&mut out, &mut para, &mut list);
            out += &format!("<h{hashes}>{}</h{hashes}>", inline(t[hashes..].trim()));
            continue;
        }
        let bullet = ["- ", "* ", "+ "].iter().find_map(|b| t.strip_prefix(b));
        let numbered = t.split_once(". ").filter(|(n, _)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())).map(|(_, rest)| rest);
        if let Some((tag, item)) = bullet.map(|i| ("ul", i)).or(numbered.map(|i| ("ol", i))) {
            if !para.is_empty() || list.is_some_and(|l| l != tag) {
                flush(&mut out, &mut para, &mut list);
            }
            if list.is_none() {
                out += &format!("<{tag}>");
                list = Some(tag);
            }
            out += &format!("<li>{}</li>", inline(item));
            continue;
        }
        if list.is_some() {
            flush(&mut out, &mut para, &mut list);
        }
        para.push(t.to_string());
    }
    if let Some(block) = code {
        out += &format!("<pre><code>{}</code></pre>", escape(&block.join("\n")));
    }
    flush(&mut out, &mut para, &mut list);
    out
}

/// An HTML fragment's text: tags stripped, a block's end a line break, entities decoded.
pub fn html_text(html: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while let Some(lt) = rest.find('<') {
        out += &rest[..lt];
        let Some(gt) = rest[lt..].find('>') else {
            out += &rest[lt..];
            rest = "";
            break;
        };
        let tag = rest[lt + 1..lt + gt].trim_start_matches('/').split([' ', '/']).next().unwrap_or("").to_ascii_lowercase();
        if matches!(tag.as_str(), "br" | "p" | "div" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "pre") && rest[lt + 1..].starts_with('/') || tag == "br" {
            out.push('\n');
        }
        rest = &rest[lt + gt + 1..];
    }
    out += rest;
    let decoded = out.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&nbsp;", "\u{a0}").replace("&amp;", "&");
    decoded.trim_end_matches('\n').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_html_format_header_points_at_its_fragment() {
        let frag = "<b>Hé</b>";
        let bytes = cf_html(frag);
        let s = String::from_utf8(bytes.clone()).unwrap();
        let num = |key: &str| -> usize { s.split(key).nth(1).unwrap()[..10].parse().unwrap() };
        assert_eq!(&bytes[num("StartFragment:")..num("EndFragment:")], frag.as_bytes());
        assert_eq!(num("EndHTML:"), bytes.len());
        assert!(s[num("StartHTML:")..].starts_with("<html>"));
    }

    #[test]
    fn markdown_renders_the_common_marks() {
        let html = markdown_html("# Plan\n\nHello **Ana**, see [the doc](https://x.test/a?b=1&c=2) and `x<y`.\n\n- one\n- *two*\n\n1. first\n2. second\n\n```\nfn a() {}\n```");
        assert_eq!(
            html,
            "<h1>Plan</h1><p>Hello <strong>Ana</strong>, see <a href=\"https://x.test/a?b=1&amp;c=2\">the doc</a> and <code>x&lt;y</code>.</p><ul><li>one</li><li><em>two</em></li></ul><ol><li>first</li><li>second</li></ol><pre><code>fn a() {}</code></pre>"
        );
        assert_eq!(markdown_html("a\nb"), "<p>a<br>b</p>");
    }

    #[test]
    fn html_text_strips_tags_and_decodes_entities() {
        assert_eq!(html_text("<p>Fish &amp; chips</p><p>2 &lt; 3<br>end</p>"), "Fish & chips\n2 < 3\nend");
        assert_eq!(html_text("<ul><li>a</li><li>b</li></ul>"), "a\nb");
    }
}
