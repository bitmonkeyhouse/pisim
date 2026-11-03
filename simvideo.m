// simvideo: streams a booted simulator's main display as raw RGBA frames, only when it changes.
// stdin, one command per line:
//   size <w> <h>   deliver frames scaled to w x h pixels (nothing is sent until this arrives)
//   next           the reader is ready for another frame
// stdout:
//   source <w> <h> the display's size in pixels, at start and whenever it changes (rotation)
//   frame <w> <h> <path>   a w x h RGBA file; the reader (the terminal, via Kitty's t=t) deletes it
// At most one frame is in flight: after "frame", nothing more is sent until "next".
//
// The display is found and followed the way Meta's idb (MIT licence) does it, in
// FBSimulatorControl/Framebuffer: the IO port whose descriptor has displayClass 0, its
// framebufferSurface IOSurface, and SimScreen frame/surface callbacks. The GPU scales the surface
// (wrapped as a Metal texture, no copy) into an RGBA texture; the CPU only reads that back.
//
// Build: clang -fobjc-arc -framework Foundation -framework IOSurface -framework Metal -framework MetalPerformanceShaders simvideo.m -o simvideo
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <Metal/Metal.h>
#import <MetalPerformanceShaders/MetalPerformanceShaders.h>
#import <dlfcn.h>

// The private CoreSimulator / CoreSimDeviceIO methods used; the IO objects are remote proxies.
@interface NSObject (CoreSimulator)
+ (id)sharedServiceContextForDeveloperDir:(NSString *)dir error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
- (NSDictionary *)devicesByUDID;
- (id)io;
- (NSArray *)ioPorts;
- (id)descriptor;
- (unsigned short)displayClass;
- (id)framebufferSurface;
- (void)registerScreenCallbacksWithUUID:(NSUUID *)uuid
                          callbackQueue:(dispatch_queue_t)queue
                          frameCallback:(void (^)(void))frame
                surfacesChangedCallback:(void (^)(id, id))surfaces
              propertiesChangedCallback:(void (^)(id))properties;
@end

static void fail(NSString *msg) {
	fprintf(stderr, "simvideo: %s\n", msg.UTF8String);
	exit(1);
}

static id device(NSString *udid) {
	if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)) fail(@"can't load CoreSimulator");
	NSTask *task = [NSTask new];
	task.launchPath = @"/usr/bin/xcode-select";
	task.arguments = @[ @"-p" ];
	NSPipe *pipe = [NSPipe pipe];
	task.standardOutput = pipe;
	[task launch];
	[task waitUntilExit];
	NSString *dev = [[[NSString alloc] initWithData:pipe.fileHandleForReading.readDataToEndOfFile encoding:NSUTF8StringEncoding]
		stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
	NSError *err;
	id context = [NSClassFromString(@"SimServiceContext") sharedServiceContextForDeveloperDir:dev error:&err];
	id d = [[[context defaultDeviceSetWithError:&err] devicesByUDID] objectForKey:[[NSUUID alloc] initWithUUIDString:udid]];
	if (!d) fail([NSString stringWithFormat:@"no simulator %@ (%@)", udid, err.localizedDescription ?: @"not found"]);
	return d;
}

// The main display's port descriptor: displayClass 0 (iOS's main screen).
static id mainDisplay(id dev) {
	for (id port in [[dev io] ioPorts]) {
		id d = [port descriptor];
		if (![d respondsToSelector:@selector(framebufferSurface)] || ![d respondsToSelector:NSSelectorFromString(@"state")]) continue;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks" // `state` by selector: the name clashes with Foundation's
		id state = [d performSelector:NSSelectorFromString(@"state")];
#pragma clang diagnostic pop
		if ([state respondsToSelector:@selector(displayClass)] && [state displayClass] == 0) return d;
	}
	fail(@"no main display (is the simulator booted?)");
	return nil;
}

// All state below is touched only on `work`.
static dispatch_queue_t work;
static IOSurfaceRef surface;
static size_t srcW, srcH, outW, outH;
static bool dirty = true, wanted = true;
static unsigned long frameNo;
static NSString *dir;
static id<MTLDevice> gpu;
static id<MTLCommandQueue> gpuQueue;
static MPSImageLanczosScale *scaler;
static id<MTLTexture> srcTex, outTex;
static void *pixels;

static void setSurface(IOSurfaceRef s) {
	if (surface) CFRelease(surface);
	surface = s ? (IOSurfaceRef)CFRetain(s) : NULL;
	srcTex = nil;
	dirty = true;
}

// Scales the current surface into an RGBA file and hands it over, if one is due.
static void deliver(void) {
	if (!surface || !dirty || !wanted) return;
	size_t w = IOSurfaceGetWidth(surface), h = IOSurfaceGetHeight(surface);
	if (w != srcW || h != srcH) { // new size: report it and wait for the reader to choose a scale
		srcW = w, srcH = h, outW = outH = 0;
		printf("source %zu %zu\n", w, h);
		return;
	}
	if (!outW) return;
	dirty = wanted = false;

	if (!srcTex) {
		MTLTextureDescriptor *d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:w height:h mipmapped:NO];
		d.usage = MTLTextureUsageShaderRead;
		srcTex = [gpu newTextureWithDescriptor:d iosurface:surface plane:0];
	}
	id<MTLCommandBuffer> cmd = [gpuQueue commandBuffer];
	[scaler encodeToCommandBuffer:cmd sourceTexture:srcTex destinationTexture:outTex]; // BGRA in, RGBA out
	[cmd commit];
	[cmd waitUntilCompleted];
	[outTex getBytes:pixels bytesPerRow:outW * 4 fromRegion:MTLRegionMake2D(0, 0, outW, outH) mipmapLevel:0];

	// Kitty's t=t: the terminal deletes the file once read, if it's in a temp dir and named like this.
	NSString *path = [dir stringByAppendingPathComponent:[NSString stringWithFormat:@"tty-graphics-protocol-%lu.rgba", frameNo++]];
	FILE *f = fopen(path.fileSystemRepresentation, "wb");
	if (!f || fwrite(pixels, 1, outW * outH * 4, f) != outW * outH * 4) fail(@"couldn't write a frame");
	fclose(f);
	printf("frame %zu %zu %s\n", outW, outH, path.UTF8String);
}

static void setSize(size_t w, size_t h) {
	outW = w, outH = h;
	MTLTextureDescriptor *d = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:w height:h mipmapped:NO];
	d.usage = MTLTextureUsageShaderWrite;
	d.storageMode = MTLStorageModeShared;
	outTex = [gpu newTextureWithDescriptor:d];
	free(pixels);
	pixels = malloc(w * h * 4);
	dirty = true;
}

int main(int argc, char **argv) {
	@autoreleasepool {
		if (argc != 2) fail(@"usage: simvideo <udid>");
		setvbuf(stdout, NULL, _IOLBF, 0);
		// Closing the pane hangs up everything in it; exit on end of input instead, which also comes
		// when the viewer goes, so the frame directory is cleaned up.
		signal(SIGHUP, SIG_IGN);
		signal(SIGINT, SIG_IGN);
		dir = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"pisim-video-%d", getpid()]];
		[NSFileManager.defaultManager createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
		work = dispatch_queue_create("simvideo", DISPATCH_QUEUE_SERIAL);
		gpu = MTLCreateSystemDefaultDevice();
		gpuQueue = [gpu newCommandQueue];
		scaler = [[MPSImageLanczosScale alloc] initWithDevice:gpu];

		id display = mainDisplay(device(@(argv[1])));
		dispatch_sync(work, ^{ setSurface((__bridge IOSurfaceRef)[display framebufferSurface]); });
		// CoreSimulator waits for these callbacks to return, so they only flag work for `work`.
		dispatch_queue_t callbacks = dispatch_queue_create("simvideo.callbacks", dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INTERACTIVE, 0));
		[display registerScreenCallbacksWithUUID:[NSUUID UUID]
			callbackQueue:callbacks
			frameCallback:^{
				dispatch_async(work, ^{
					dirty = true;
					deliver();
				});
			}
			surfacesChangedCallback:^(id framebuffer, id masked) {
				IOSurfaceRef s = (IOSurfaceRef)CFBridgingRetain(framebuffer);
				dispatch_async(work, ^{
					setSurface(s);
					if (s) CFRelease(s);
					deliver();
				});
			}
			propertiesChangedCallback:^(id properties){
			}];
		dispatch_async(work, ^{ deliver(); });

		char line[64];
		size_t w, h;
		while (fgets(line, sizeof line, stdin)) {
			if (sscanf(line, "size %zu %zu", &w, &h) == 2 && w && h) {
				dispatch_async(work, ^{
					setSize(w, h);
					deliver();
				});
			} else if (!strncmp(line, "next", 4)) {
				dispatch_async(work, ^{
					wanted = true;
					deliver();
				});
			}
		}
		dispatch_sync(work, ^{ [NSFileManager.defaultManager removeItemAtPath:dir error:nil]; });
	}
	return 0;
}
