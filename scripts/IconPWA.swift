import AppKit
let output = CommandLine.arguments[1]
// Export the existing flower for Android installation and its monochrome notification icon.
for size in [96,192,512] {
    let badge = size == 96
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let ctx = NSGraphicsContext.current!.cgContext
    ctx.scaleBy(x: CGFloat(size)/1024, y: CGFloat(size)/1024)
    if !badge {
    ctx.setFillColor(NSColor(srgbRed: 1, green: 247/255, blue: 239/255, alpha: 1).cgColor)
    ctx.addPath(CGPath(roundedRect: CGRect(x: 24,y: 24,width: 976,height: 976), cornerWidth: 210, cornerHeight: 210, transform: nil));ctx.fillPath()
    }
    ctx.translateBy(x: 100,y: 914);ctx.scaleBy(x: 8.24,y: -8.24)
    ctx.setLineWidth(3);ctx.setLineCap(.round)
    ctx.setStrokeColor(NSColor(srgbRed: 36/255,green: 33/255,blue: 34/255,alpha: 1).cgColor)
    ctx.setFillColor(NSColor(srgbRed: 241/255,green: 162/255,blue: 199/255,alpha: 1).cgColor)
    if badge { ctx.setStrokeColor(NSColor.white.cgColor); ctx.setFillColor(NSColor.white.cgColor) }
    ctx.move(to: CGPoint(x:50,y:24))
    for v: [CGFloat] in [[23,-6,3,24,25,42],[-10,48,6,81,33,68],[29,105,67,105,68,72],[95,91,111,58,80,46],[107,21,76,-1,59,26]] { ctx.addCurve(to: CGPoint(x:v[4],y:v[5]), control1: CGPoint(x:v[0],y:v[1]), control2: CGPoint(x:v[2],y:v[3])) }
    ctx.closePath();ctx.drawPath(using: .fillStroke)
    if !badge {
    ctx.setFillColor(NSColor(srgbRed:1,green:189/255,blue:66/255,alpha:1).cgColor)
    ctx.addEllipse(in: CGRect(x:34,y:33,width:34,height:34));ctx.drawPath(using:.fillStroke)
    ctx.move(to:CGPoint(x:44,y:53));ctx.addQuadCurve(to:CGPoint(x:59,y:53),control:CGPoint(x:52,y:60))
    ctx.move(to:CGPoint(x:45,y:43));ctx.addLine(to:CGPoint(x:45,y:46))
    ctx.move(to:CGPoint(x:57,y:43));ctx.addLine(to:CGPoint(x:57,y:46));ctx.strokePath()
    }
    NSGraphicsContext.restoreGraphicsState()
    let data=bitmap.representation(using:.png,properties:[:])!
    let filename = badge ? "notification-badge.png" : "icon_\(size).png"
    try data.write(to: URL(fileURLWithPath:output+"/"+filename.replacingOccurrences(of:"_",with:"-")))
}
